import Foundation
import AppKit
import ApplicationServices
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit
import Carbon.HIToolbox

struct BridgeFailure: Error {
	let message: String
	let code: String
	var evidence: [String: Int]? = nil

	var wireError: [String: Any] {
		var result: [String: Any] = ["message": message, "code": code]
		if let evidence { result["evidence"] = evidence }
		return result
	}
}

struct CGWindowCandidate {
	let windowId: UInt32
	let title: String
	let bounds: CGRect
	let isOnscreen: Bool
	let layer: Int
	let zOrder: Int
}

struct CGWindowOwnerSummary {
	let pid: Int32
	let name: String
}

/// Hash consistent with `CFEqual` on AX handles, so equivalent fresh handles share a bucket.
func axEquivalenceHash(_ element: AXUIElement) -> Int {
	bucketKey(CFHash(element))
}

/// Total `UInt` -> `Int` mapping; `Int(hash)` would trap for hashes with the top bit set.
func bucketKey(_ hash: UInt) -> Int {
	Int(bitPattern: hash)
}

struct AXDescendant<Element> {
	let element: Element
	let depth: Int
	let insideWebArea: Bool
	let axVisible: Bool
}

/// What an AX attribute read proved: a value, an authoritative absence, or nothing at all.
enum AXReadEvidence: Equatable {
	case present
	case absent
	case failed
}

/// Classify an AX read status. Only success and the statuses stating that the attribute or element does
/// not exist are evidence; a timeout (`cannotComplete`) or any other failure proves nothing.
func axReadEvidence(_ status: AXError) -> AXReadEvidence {
	switch status {
	case .success: return .present
	case .noValue, .attributeUnsupported, .invalidUIElement: return .absent
	default: return .failed
	}
}

/// A string attribute read: its value, an authoritative absence, or a failed read.
enum AXStringRead: Equatable {
	case value(String)
	case absent
	case failed
}

/// The element fields a `waitFor` condition reads.
enum AXWaitField {
	case role
	case title
	case description
	case value
}

/// Tri-state `waitFor` predicate over lowercased `text` and `value`: `nil` when a failed read leaves the
/// match undecided, so the element can neither match nor prove the condition absent.
func axWaitConditionMatch(role: String?, text: String?, value: String?, read: (AXWaitField) -> AXStringRead) -> Bool? {
	var undecided = false
	if let role, !role.isEmpty {
		switch read(.role) {
		case .value(let actual) where actual != role: return false
		case .absent: return false
		case .failed: undecided = true
		default: break
		}
	}
	if let text, !text.isEmpty {
		var haystack: [String] = []
		var unread = false
		for field in [AXWaitField.title, .description, .value] {
			switch read(field) {
			case .value(let actual): haystack.append(actual)
			case .absent: haystack.append("")
			case .failed: haystack.append(""); unread = true
			}
		}
		if !haystack.joined(separator: "\n").lowercased().contains(text) {
			if !unread { return false }
			undecided = true
		}
	}
	if let value, !value.isEmpty {
		switch read(.value) {
		case .value(let actual) where actual.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != value: return false
		case .absent: return false
		case .failed: undecided = true
		default: break
		}
	}
	return undecided ? nil : true
}

/// A bounded walk's nodes, and whether they are the whole subtree.
struct AXTraversal<Element> {
	let nodes: [AXDescendant<Element>]
	/// False when a child read failed, a node at the depth limit has or may have children, or the node
	/// budget cut the walk: a node missing from `nodes` is then not proven absent.
	let complete: Bool
}

/// The AX queries needed for a bounded, breadth-first descendant walk.
struct AXTraversalWorld<Element: AnyObject> {
	let role: (Element) -> String
	/// `nil` when the children could not be read; an authoritative empty list is `[]`.
	let childLists: (Element) -> (all: [Element], visible: [Element]?)?
	let sameElement: (Element, Element) -> Bool
	/// Must agree with `sameElement`: equal elements hash equally. Collisions only cost comparisons.
	let hash: (Element) -> Int

	func collect(startingAt root: Element, maxDepth: Int, maxNodes: Int) -> [AXDescendant<Element>] {
		walk(startingAt: root, maxDepth: maxDepth, maxNodes: maxNodes, checkFrontier: false).nodes
	}

	/// `checkFrontier` reads the children of nodes at `maxDepth`, so a cut below them marks the walk incomplete.
	func walk(startingAt root: Element, maxDepth: Int, maxNodes: Int, checkFrontier: Bool) -> AXTraversal<Element> {
		let nodeLimit = max(1, maxNodes)
		var queue: [(Element, Int, Bool, Bool)] = [(root, 0, false, true)]
		// Visited elements bucketed by `hash`, so `sameElement` (CFEqual) only runs within a bucket.
		// A linear scan of `output` was O(n^2) CFEqual calls at the 2000-5000 node budgets.
		var seen: [Int: [Element]] = [:]
		var index = 0
		var output: [AXDescendant<Element>] = []
		var complete = true
		// The queue never outgrows `nodeLimit`, so the budget shows up as children left unqueued.
		while index < queue.count && output.count < nodeLimit {
			let (element, depth, parentInsideWebArea, inheritedVisible) = queue[index]
			index += 1
			// AX can return a fresh handle for an element already visited, so dedupe by equivalence.
			// Queue slots still count queued duplicates against the node budget (rule unchanged).
			let bucket = hash(element)
			if seen[bucket, default: []].contains(where: { sameElement($0, element) }) { continue }
			seen[bucket, default: []].append(element)
			let elementRole = role(element)
			let insideWebArea = parentInsideWebArea || elementRole == "AXWebArea"
			output.append(AXDescendant(element: element, depth: depth, insideWebArea: insideWebArea, axVisible: inheritedVisible))
			if depth >= maxDepth {
				if checkFrontier && childLists(element)?.all.isEmpty != true { complete = false }
				continue
			}
			guard let (childElements, visible) = childLists(element) else {
				complete = false
				continue
			}
			for child in childElements {
				if queue.count >= nodeLimit {
					complete = false
					break
				}
				let childVisible = inheritedVisible && (visible.map { set in set.contains { sameElement($0, child) } } ?? true)
				queue.append((child, depth + 1, insideWebArea, childVisible))
			}
		}
		return AXTraversal(nodes: output, complete: complete)
	}

	/// One `waitFor` pass over `root`, bounded by `waitForMaxDepth` and `waitForMaxNodes`.
	/// - Parameters:
	///   - scopeExact: Test only `root`, so nothing below it can hide a match.
	///   - matches: The tri-state predicate; `nil` when a failed read leaves the element undecided.
	func waitPass(startingAt root: Element, scopeExact: Bool, matches: (Element) -> Bool?) -> AXWaitPass<Element> {
		let traversal = walk(startingAt: root, maxDepth: scopeExact ? 0 : waitForMaxDepth, maxNodes: waitForMaxNodes, checkFrontier: !scopeExact)
		// Absence needs the whole scope walked and every predicate read: an unread subtree or field may hold the match.
		var undecided = !traversal.complete
		for candidate in traversal.nodes {
			guard let matched = matches(candidate.element) else {
				undecided = true
				continue
			}
			if matched { return AXWaitPass(nodes: traversal.nodes, verdict: .found(candidate)) }
		}
		return AXWaitPass(nodes: traversal.nodes, verdict: undecided ? .undecided : .absent)
	}
}

/// The AX queries a look's outline walk needs, injectable so headless tests drive the production walk.
struct LookOutlineWorld<Element: AnyObject> {
	/// `nil` when the children could not be read; an authoritative empty list is `[]`.
	let children: (Element) -> [Element]?
	/// The root's node.
	let rootNode: (Element) -> LookNode
	/// The node builder for one parent's children, so per-parent reads (e.g. visible children) run once.
	let childNodes: (Element) -> (Element) -> LookNode
	/// The monotonic clock (seconds) the walk's time budget runs on.
	let now: () -> TimeInterval

	/// Build `root`'s node, then walk breadth-first below it until `nodeLimit` nodes, `timeLimit` seconds after the
	/// root node was built (the root's own reads never spend the walk's budget) or `requestDeadline` on `now`'s clock,
	/// whichever comes first: a slow root cannot push the walk past the client's timeout. Past the deadline no queued
	/// node's children are read. A node whose children could not be read, or whose children the budget cut, is
	/// `truncated`: its subtree is unread, never a leaf.
	func build(root: Element, nodeLimit: Int, timeLimit: TimeInterval, requestDeadline: TimeInterval) -> LookNode {
		let rootNode = self.rootNode(root)
		let deadline = min(now() + timeLimit, requestDeadline)
		let expired = { now() >= deadline }
		var walked = 1
		var seen = Set<ObjectIdentifier>([ObjectIdentifier(root)])
		var queue: [(Element, LookNode)] = [(root, rootNode)]
		var index = 0
		while index < queue.count {
			let (element, node) = queue[index]
			index += 1
			if expired() {
				node.truncated = true
				continue
			}
			guard let elements = children(element) else {
				node.truncated = true
				continue
			}
			if elements.isEmpty { continue }
			if walked >= nodeLimit {
				node.truncated = true
				continue
			}
			let childNode = childNodes(element)
			for child in elements {
				if walked >= nodeLimit || expired() {
					node.truncated = true
					break
				}
				if !seen.insert(ObjectIdentifier(child)).inserted { continue }
				let built = childNode(child)
				node.children.append(built)
				queue.append((child, built))
				walked += 1
			}
		}
		return rootNode
	}
}

/// Seconds after a look starts by which its outline walk stops, whatever the root's own reads cost: the client
/// aborts a look at 33 s (`LOOK_TIMEOUT_MS`), and the rest leaves room for OCR and the reply.
let lookWalkDeadline: TimeInterval = 25

/// The deepest level below its scope a `waitFor` pass walks.
let waitForMaxDepth = 12
/// The most nodes one `waitFor` pass walks.
let waitForMaxNodes = 2000

/// What one `waitFor` pass proved.
enum AXWaitVerdict<Element> {
	case found(AXDescendant<Element>)
	/// The whole scope was walked and read, and nothing matched.
	case absent
	/// Nothing matched, but an unread subtree or field may hold a match.
	case undecided
}

/// One `waitFor` pass: the nodes it walked and its verdict.
struct AXWaitPass<Element> {
	let nodes: [AXDescendant<Element>]
	let verdict: AXWaitVerdict<Element>
}

/// The most AX windows one root inventory lists.
let windowListCap = 128

/// A root inventory lists a window only at least this large; smaller ones are helper panels and slivers.
func inventoryFrameUsable(_ frame: CGRect) -> Bool {
	frame.width >= 100 && frame.height >= 80
}

/// A window list is the whole inventory only when it was read and fits under `windowListCap`.
func windowListComplete(_ count: Int?) -> Bool {
	count.map { $0 <= windowListCap } ?? false
}

/// One AX size read: the value and its evidence decoded from the same reply.
enum AXSizeRead: Equatable {
	case size(CGSize)
	case absent
	case failed
}

/// The AX reads one pid's window inventory needs, injectable so headless tests drive production assembly.
struct WindowInventoryWorld<Element: AnyObject> {
	/// `AXWindows`; `nil` when the read failed.
	let windows: () -> [Element]?
	/// The main and focused windows, deduplicated: the fallback when `AXWindows` lists none.
	let fallbackWindows: () -> [Element]
	/// `nil` when the read failed; an absent or undecodable position is `.zero`.
	let position: (Element) -> CGPoint?
	let size: (Element) -> AXSizeRead
	/// Not `complete` when a sheet source or a child's role could not be read.
	let sheets: (Element) -> (sheets: [Element], complete: Bool)
}

/// The windows `AXWindows` (or its main/focused fallback) named, capped at `windowListCap`.
struct WindowListing<Element> {
	let windows: [Element]
	/// The list was read and fit under the cap.
	let complete: Bool
}

/// A window kept by the inventory, with the frames and sheets its root entry reports.
struct InventoryWindow<Element> {
	let element: Element
	/// Its index in the listing, the z-order of an unpaired window.
	let listIndex: Int
	let axFrame: CGRect
	/// Both `axFrame` reads answered (a value or an authoritative absence): a failed one reads as `.zero`.
	let axFrameRead: Bool
	let effectiveFrame: CGRect
	let sheets: [Element]
}

/// One pid's kept windows. Every kept window is a validated positive match even when the inventory is not
/// `complete`; only a `complete` inventory proves that a missing root closed.
struct WindowInventorySelection<Element> {
	let windows: [InventoryWindow<Element>]
	let complete: Bool
}

extension WindowInventoryWorld {
	/// Read `AXWindows` once. A failed or over-cap list still names its first `windowListCap` windows.
	func listing() -> WindowListing<Element> {
		let listed = windows()
		let capped = Array((listed ?? []).prefix(windowListCap))
		// The main/focused fallback recovers at most those two windows, never an unfocused one or its sheet.
		return WindowListing(windows: capped.isEmpty ? fallbackWindows() : capped, complete: windowListComplete(listed?.count))
	}

	/// Keep the listed windows of a usable size with their sheets. A failed size read is retried once, only when
	/// usable paired CG bounds do not already admit the window. A window skipped as too small only because its
	/// size stayed unreadable, or a failed sheet read, leaves the inventory incomplete.
	/// - Parameter pairedBounds: The paired CG window's bounds, `nil` for an unpaired window.
	func select(_ listing: WindowListing<Element>, pairedBounds: (Element) -> CGRect?) -> WindowInventorySelection<Element> {
		var complete = listing.complete
		var kept: [InventoryWindow<Element>] = []
		for (listIndex, window) in listing.windows.enumerated() {
			let paired = pairedBounds(window)
			// The filter and the evidence come from the same reply; a retry replaces both. Paired bounds that admit
			// the window settle a failed read without a serial retry against the listing budget.
			var read = size(window)
			if read == .failed && !(paired.map(inventoryFrameUsable) ?? false) { read = size(window) }
			var axSize = CGSize.zero
			if case .size(let value) = read { axSize = value }
			let origin = position(window)
			let axFrame = CGRect(origin: origin ?? .zero, size: axSize)
			let effectiveFrame = axFrame.width > 1 && axFrame.height > 1 ? axFrame : (paired ?? axFrame)
			if !inventoryFrameUsable(effectiveFrame) {
				// Skipped as too small only because its size was unreadable, a live window is unknown.
				if paired == nil && read == .failed { complete = false }
				continue
			}
			let sheetInventory = sheets(window)
			if !sheetInventory.complete { complete = false }
			kept.append(InventoryWindow(element: window, listIndex: listIndex, axFrame: axFrame, axFrameRead: origin != nil && read != .failed, effectiveFrame: effectiveFrame, sheets: sheetInventory.sheets))
		}
		return WindowInventorySelection(windows: kept, complete: complete)
	}
}

/// One pid's roots keyed by identity, and whether the listing was the whole inventory.
struct RootInventorySnapshot {
	let roots: [String: [String: Any]]
	let complete: Bool
}

extension RootInventorySnapshot {
	/// Key `roots` by `identity`. A root in `unidentifiedRefs` (by `rootRef`: one whose pairing or identity reads failed,
	/// see `rootIdentityComparable`) or whose key another root shares has no stable identity: it is left out and the
	/// snapshot is incomplete, so it can neither appear, close nor gain focus, and a root missing next to it is not proven
	/// closed. It is left out of this comparison only: discovery still lists it as a positive match.
	init(roots: [[String: Any]], complete: Bool, unidentifiedRefs: Set<String>, identity: ([String: Any]) -> String) {
		var keyed: [String: [String: Any]] = [:]
		var ambiguous = Set<String>()
		var whole = complete
		for root in roots {
			if let ref = root["rootRef"] as? String, unidentifiedRefs.contains(ref) {
				whole = false
				continue
			}
			let key = identity(root)
			if ambiguous.contains(key) { continue }
			if keyed.removeValue(forKey: key) != nil {
				ambiguous.insert(key)
				whole = false
				continue
			}
			keyed[key] = root
		}
		self.init(roots: keyed, complete: whole)
	}
}

/// Root changes between two listings. Absence from an incomplete listing proves nothing: a root missing
/// from `after` closed only when `after` is complete, and one missing from `before` appeared (or newly
/// gained focus) only when `before` is complete. Only a root's own focus read is compared (`rootOwnFocus`): a root present
/// in both listings gained focus when it reads `true` after and `false` before, so a root whose focus read failed on
/// either side (no `isFocused`, see `RootState`), a sheet whose own `AXFocused` was not read, or a menu (its focus is
/// stamped, never read) never reports a focus change. A root new in `after` whose own focus reads `true` reports both
/// `appeared` and `focused`.
func rootInventoryChanges(before: RootInventorySnapshot, after: RootInventorySnapshot) -> [(change: String, root: [String: Any])] {
	var changes: [(change: String, root: [String: Any])] = []
	if before.complete {
		for (key, root) in after.roots where before.roots[key] == nil { changes.append(("appeared", root)) }
	}
	if after.complete {
		for (key, root) in before.roots where after.roots[key] == nil { changes.append(("closed", root)) }
	}
	for (key, root) in after.roots where rootOwnFocus(root) == true {
		guard let previous = before.roots[key] else {
			if before.complete { changes.append(("focused", root)) }
			continue
		}
		if rootOwnFocus(previous) == false { changes.append(("focused", root)) }
	}
	return changes
}

/// A root entry's own focus read, `nil` when there is none. A window's `isFocused` is its own `AXFocused` read; a sheet's
/// is its window's (see `rootEntries`), so a sheet answers with its own read `ownFocus`; a popup menu's `isFocused` is
/// stamped `true` without any read, so a menu has none (#1303).
func rootOwnFocus(_ root: [String: Any]) -> Bool? {
	switch root["kind"] as? String {
	case "sheet": return root["ownFocus"] as? Bool
	case "menu": return nil
	default: return root["isFocused"] as? Bool
	}
}

struct WindowPairing {
	let candidate: CGWindowCandidate?
	let score: Double
	let confidence: String
	/// Its title or frame read failed, so the pairing (or its absence) rests on partial evidence.
	var unread = false
	/// Another root claims one of its candidates, or it claims more than one (see `contestedClaims`).
	var contested = false
}

/// The title and frame one CG pairing scores, `nil` where the read failed.
struct WindowPairingRead {
	let title: String?
	let frame: CGRect?

	/// An absent title is `""`; a failed title read, or a failed position or size read, is `nil`.
	init(title: AXStringRead, frame: CGRect, frameRead: Bool) {
		switch title {
		case .value(let value): self.title = value
		case .absent: self.title = ""
		case .failed: self.title = nil
		}
		self.frame = frameRead ? frame : nil
	}

	var unread: Bool { title == nil || frame == nil }
}

func windowPairScore(frame: CGRect, title: String, candidate: CGWindowCandidate) -> Double {
	var score = 0.0
	let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	let candidateTitle = candidate.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	if !normalizedTitle.isEmpty && !candidateTitle.isEmpty {
		if normalizedTitle == candidateTitle {
			score += 100
		} else if normalizedTitle.contains(candidateTitle) || candidateTitle.contains(normalizedTitle) {
			score += 50
		}
	}
	if frame.width > 1 && frame.height > 1 {
		let dx = abs(candidate.bounds.origin.x - frame.origin.x)
		let dy = abs(candidate.bounds.origin.y - frame.origin.y)
		let dw = abs(candidate.bounds.size.width - frame.size.width)
		let dh = abs(candidate.bounds.size.height - frame.size.height)
		score -= Double(dx + dy + dw + dh) / 20.0
	}
	if candidate.isOnscreen { score += 10 }
	return score
}

func pairingConfidence(frame: CGRect, title: String, candidate: CGWindowCandidate, score: Double) -> String {
	guard frame.width > 1 && frame.height > 1 else { return "low" }
	let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	let candidateTitle = candidate.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	let titleEqual = !normalizedTitle.isEmpty && !candidateTitle.isEmpty && normalizedTitle == candidateTitle
	let geometryExact = abs(frame.origin.x - candidate.bounds.origin.x) <= 2 && abs(frame.origin.y - candidate.bounds.origin.y) <= 2 && abs(frame.width - candidate.bounds.width) <= 2 && abs(frame.height - candidate.bounds.height) <= 2
	if titleEqual && geometryExact { return "exact" }
	if score >= 50 { return "high" }
	return "low"
}

/// Pair each window with at most one CG candidate and each candidate with at most one window, best score first, from
/// one `read` per window; a pairing scoring below 0 leaves the window unpaired. A failed title or frame read adds no
/// score and no penalty (it scores as an empty title or a degenerate frame) and marks the pairing `unread`.
func pairWindows<Element: AnyObject>(_ windows: [Element], candidates: [CGWindowCandidate], read: (Element) -> WindowPairingRead) -> [ObjectIdentifier: WindowPairing] {
	pairWindows(windows, reads: windows.map(read), candidates: candidates)
}

/// `pairWindows` from reads already taken, `reads[i]` for `windows[i]`.
func pairWindows<Element: AnyObject>(_ windows: [Element], reads: [WindowPairingRead], candidates: [CGWindowCandidate]) -> [ObjectIdentifier: WindowPairing] {
	var pairs: [(index: Int, candidate: CGWindowCandidate, score: Double)] = []
	for (index, evidence) in reads.enumerated() {
		for candidate in candidates {
			pairs.append((index, candidate, windowPairScore(frame: evidence.frame ?? .zero, title: evidence.title ?? "", candidate: candidate)))
		}
	}
	pairs.sort { $0.score > $1.score }
	var output: [ObjectIdentifier: WindowPairing] = [:]
	var usedCandidateIds = Set<UInt32>()
	for pair in pairs {
		let key = ObjectIdentifier(windows[pair.index])
		if output[key] != nil || usedCandidateIds.contains(pair.candidate.windowId) { continue }
		usedCandidateIds.insert(pair.candidate.windowId)
		let evidence = reads[pair.index]
		let confidence = pairingConfidence(frame: evidence.frame ?? .zero, title: evidence.title ?? "", candidate: pair.candidate, score: pair.score)
		output[key] = WindowPairing(candidate: pair.score >= 0 ? pair.candidate : nil, score: pair.score, confidence: confidence, unread: evidence.unread)
	}
	for (window, evidence) in zip(windows, reads) where output[ObjectIdentifier(window)] == nil {
		output[ObjectIdentifier(window)] = WindowPairing(candidate: nil, score: -Double.greatestFiniteMagnitude, confidence: "low", unread: evidence.unread)
	}
	return output
}

/// Pair sheets (see `pairWindows`) with the CG windows no window took. A sheet has a CG window id only when it pairs
/// with a CG window of its own: one without (its window's is the only candidate) is unpaired, never its window's twin.
func pairSheets<Element: AnyObject>(
	_ sheets: [Element], candidates: [CGWindowCandidate], windowPairings: [ObjectIdentifier: WindowPairing], read: (Element) -> WindowPairingRead
) -> [ObjectIdentifier: WindowPairing] {
	pairSheets(sheets, reads: sheets.map(read), candidates: candidates, windowPairings: windowPairings)
}

/// `pairSheets` from reads already taken, `reads[i]` for `sheets[i]`.
func pairSheets<Element: AnyObject>(
	_ sheets: [Element], reads: [WindowPairingRead], candidates: [CGWindowCandidate], windowPairings: [ObjectIdentifier: WindowPairing]
) -> [ObjectIdentifier: WindowPairing] {
	let taken = Set(windowPairings.values.compactMap { $0.candidate?.windowId })
	return pairWindows(sheets, reads: reads, candidates: candidates.filter { !taken.contains($0.windowId) })
}

/// The one rule that keeps the pairing heuristic from deciding `rootDelta`: a root claims a CG candidate when it scores
/// 0 or more for it, or when its own pairing read failed (an unread title or frame could score anything). A root's
/// pairing is contested unless it claims no candidate, or exactly one that no other root claims: only then is the
/// assignment the same whatever the listing order, the score ties or an unread competitor. `contestedClaims(reads)[i]`
/// is `reads[i]`'s verdict; every root of one listing (windows and sheets) competes for every candidate.
func contestedClaims(_ reads: [WindowPairingRead], candidates: [CGWindowCandidate]) -> [Bool] {
	let claims = reads.map { read in
		candidates.indices.filter { read.unread || windowPairScore(frame: read.frame ?? .zero, title: read.title ?? "", candidate: candidates[$0]) >= 0 }
	}
	var claimants = [Int](repeating: 0, count: candidates.count)
	for claimed in claims {
		for index in claimed { claimants[index] &+= 1 }
	}
	return claims.map { claimed in claimed.count > 1 || claimed.contains { claimants[$0] > 1 } }
}

func rootKind(role: String, subrole: String) -> String {
	if role == "AXSheet" { return "sheet" }
	if subrole.localizedCaseInsensitiveContains("popover") { return "popover" }
	if subrole.localizedCaseInsensitiveContains("dialog") || role == "AXDialog" { return "dialog" }
	return "window"
}

/// One identity field of a root: the value `rootIdentity` keys it by, and whether that value was read.
struct RootIdentityField: Equatable {
	let value: String
	let read: Bool

	init(value: String, read: Bool = true) {
		self.value = value
		self.read = read
	}

	/// A failed read keeps `fallback`'s value but is unread. An absent one takes `fallback` whole, so a fallback that was
	/// itself unread stays unread only when it was used.
	init(_ evidence: AXStringRead, fallback: RootIdentityField = RootIdentityField(value: "")) {
		switch evidence {
		case .value(let value): self.init(value: value)
		case .absent: self = fallback
		case .failed: self.init(value: fallback.value, read: false)
		}
	}
}

/// Whether `rootIdentity` keys a root the same way in every listing. A paired root is keyed by its CG window id and an
/// unpaired one by kind, role, title and frame, so every read that decided the key must have answered: the pairing's own
/// title and frame reads (a later successful read does not vouch for a failed pairing), and, unpaired, `fields` and the frame.
/// A `contested` pairing (see `contestedClaims`) never keys a root, paired or not.
func rootIdentityComparable(pairing: WindowPairing, fields: [RootIdentityField], frameRead: Bool) -> Bool {
	if pairing.unread || pairing.contested { return false }
	return pairing.candidate != nil || (frameRead && fields.allSatisfy(\.read))
}

/// The AX string attributes a root identity reads.
enum RootIdentityAttribute {
	case title
	case role
	case subrole
}

/// The AX boolean states a root reports.
enum RootStateAttribute {
	case focused
	case main
	case minimized
}

/// Decode one root-state AX reply (`AXFocused`, `AXMain`, `AXMinimized`): only a successful reply that IS a `CFBoolean`
/// is evidence. No reply, or any other type, e.g. a numeric `0` or `2`, is unknown (`nil`), never `false` (#1303).
func rootStateBoolean(_ value: AnyObject?) -> Bool? {
	guard let value, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
	return value as? Bool
}

/// A root's `AXFocused`, `AXMain` and `AXMinimized`: `nil` unless the read returned a boolean (`rootStateBoolean`). A
/// failed, absent or undecodable read is unknown, never `false`, and its key is left out of the root entry.
struct RootState: Equatable {
	let focused: Bool?
	let main: Bool?
	let minimized: Bool?
}

/// One classified root: what `rootIdentity` keys it by, its CG pairing, and whether that key is comparable.
struct InventoryRoot<Element> {
	let element: Element
	let kind: String
	let title: RootIdentityField
	let role: RootIdentityField
	let subrole: RootIdentityField
	/// The frame it reports: a window's effective frame, a sheet's AX frame.
	let frame: CGRect
	let pairing: WindowPairing
	let comparable: Bool
	/// Its own state reads. A sheet reads only its own `AXFocused`, never its window's; it is never main or minimized.
	let state: RootState
}

/// A kept window's root and its sheets' roots.
struct ClassifiedWindow<Element> {
	let window: InventoryWindow<Element>
	let root: InventoryRoot<Element>
	let sheets: [InventoryRoot<Element>]
}

/// The AX reads one pid's root inventory needs, injectable so headless tests drive pairing and classification into
/// `rootDelta`.
struct RootInventoryWorld<Element: AnyObject> {
	let windows: WindowInventoryWorld<Element>
	let string: (Element, RootIdentityAttribute) -> AXStringRead
	/// A sheet's AX frame and whether its position and size reads answered.
	let frame: (Element) -> (frame: CGRect, read: Bool)
	/// The title and frame one CG pairing scores.
	let pairingRead: (Element) -> WindowPairingRead
	/// One boolean state read, `nil` unless it returned a boolean (see `RootState`).
	let state: (Element, RootStateAttribute) -> Bool?
}

extension RootInventoryWorld {
	/// List the windows, pair them with `candidates`, keep the usable ones (see `WindowInventoryWorld.select`) and
	/// classify each with its sheets (paired by `pairSheets`). A sheet's absent title falls back to its window's. Every
	/// listed window and kept sheet competes in `contestedClaims`, which marks the pairings no root can be keyed by.
	func classify(candidates: [CGWindowCandidate]) -> (windows: [ClassifiedWindow<Element>], complete: Bool) {
		let listing = windows.listing()
		let windowReads = listing.windows.map(pairingRead)
		var pairings = pairWindows(listing.windows, reads: windowReads, candidates: candidates)
		let selection = windows.select(listing) { pairings[ObjectIdentifier($0)]?.candidate?.bounds }
		let unpaired = WindowPairing(candidate: nil, score: -Double.greatestFiniteMagnitude, confidence: "low")
		let keptSheets = selection.windows.flatMap(\.sheets)
		let sheetReads = keptSheets.map(pairingRead)
		var sheetPairings = pairSheets(keptSheets, reads: sheetReads, candidates: candidates, windowPairings: pairings)
		for (index, contested) in contestedClaims(windowReads + sheetReads, candidates: candidates).enumerated() where contested {
			if index < listing.windows.count {
				pairings[ObjectIdentifier(listing.windows[index])]?.contested = true
			} else {
				sheetPairings[ObjectIdentifier(keptSheets[index &- listing.windows.count])]?.contested = true
			}
		}
		let classified = selection.windows.map { kept -> ClassifiedWindow<Element> in
			let window = kept.element
			let pairing = pairings[ObjectIdentifier(window)] ?? unpaired
			let axTitle = RootIdentityField(string(window, .title))
			let role = RootIdentityField(string(window, .role))
			let subrole = RootIdentityField(string(window, .subrole))
			var title = axTitle
			let axTitleUsable = kept.axFrame.width > 1 && kept.axFrame.height > 1 && !axTitle.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
			if !axTitleUsable, let cgTitle = pairing.candidate?.title, !cgTitle.isEmpty { title = RootIdentityField(value: cgTitle) }
			let root = InventoryRoot(
				element: window, kind: rootKind(role: role.value, subrole: subrole.value), title: title, role: role, subrole: subrole,
				frame: kept.effectiveFrame, pairing: pairing,
				comparable: rootIdentityComparable(pairing: pairing, fields: [title, role, subrole], frameRead: kept.axFrameRead),
				state: RootState(focused: state(window, .focused), main: state(window, .main), minimized: state(window, .minimized)))
			let sheets = kept.sheets.map { sheet -> InventoryRoot<Element> in
				let sheetPairing = sheetPairings[ObjectIdentifier(sheet)] ?? unpaired
				let sheetTitle = RootIdentityField(string(sheet, .title), fallback: title)
				let sheetRole = RootIdentityField(string(sheet, .role), fallback: RootIdentityField(value: "AXSheet"))
				let sheetSubrole = RootIdentityField(string(sheet, .subrole))
				let (sheetFrame, sheetFrameRead) = frame(sheet)
				return InventoryRoot(
					element: sheet, kind: "sheet", title: sheetTitle, role: sheetRole, subrole: sheetSubrole, frame: sheetFrame, pairing: sheetPairing,
					comparable: rootIdentityComparable(pairing: sheetPairing, fields: [sheetTitle, sheetRole, sheetSubrole], frameRead: sheetFrameRead),
					state: RootState(focused: state(sheet, .focused), main: false, minimized: false))
			}
			return ClassifiedWindow(window: kept, root: root, sheets: sheets)
		}
		return (classified, selection.complete)
	}
}

/// Root entries for `windows`, each window followed by its sheets: `extras` (given the window and, for a sheet, the
/// sheet's root) under the identity fields `rootIdentity` reads and the state flags, and the `rootRef`s of the roots it
/// cannot key. A flag that was not read (see `RootState`) is left out, whatever `extras` says. `isOnscreen` is the paired
/// CG window's (a sheet without one takes its window's), else the negated `isMinimized` of its window, else left out.
/// A sheet's `isFocused` is its window's read focus, as root selection, `find_roots` and ref records have always read
/// it; its own `AXFocused` read, when it returned a boolean, is `ownFocus`, the only focus `rootInventoryChanges`
/// compares for a sheet.
func rootEntries<Element>(
	_ windows: [ClassifiedWindow<Element>], ref: (Element) -> String,
	extras: (ClassifiedWindow<Element>, InventoryRoot<Element>?) -> [String: Any]
) -> (roots: [[String: Any]], unidentified: Set<String>) {
	var roots: [[String: Any]] = []
	var unidentified = Set<String>()
	func append(_ root: InventoryRoot<Element>, onscreen: Bool?, windowFocus: Bool? = nil, extras: [String: Any]) {
		let rootRef = ref(root.element)
		var entry = extras
		if root.kind == "sheet" {
			entry["isFocused"] = windowFocus.map { $0 as Any }
			entry["ownFocus"] = root.state.focused.map { $0 as Any }
		} else {
			entry["isFocused"] = root.state.focused.map { $0 as Any }
		}
		entry["isMain"] = root.state.main.map { $0 as Any }
		entry["isMinimized"] = root.state.minimized.map { $0 as Any }
		entry["isOnscreen"] = onscreen.map { $0 as Any }
		entry["kind"] = root.kind
		entry["rootRef"] = rootRef
		entry["windowRef"] = rootRef
		entry["title"] = root.title.value
		entry["role"] = root.role.value
		entry["subrole"] = root.subrole.value
		entry["framePoints"] = ["x": root.frame.origin.x, "y": root.frame.origin.y, "w": root.frame.width, "h": root.frame.height]
		if let candidate = root.pairing.candidate { entry["windowId"] = Int(candidate.windowId) }
		if !root.comparable { unidentified.insert(rootRef) }
		roots.append(entry)
	}
	for window in windows {
		let onscreen = window.root.pairing.candidate?.isOnscreen ?? window.root.state.minimized.map { !$0 }
		append(window.root, onscreen: onscreen, extras: extras(window, nil))
		for sheet in window.sheets {
			append(sheet, onscreen: sheet.pairing.candidate?.isOnscreen ?? onscreen, windowFocus: window.root.state.focused, extras: extras(window, sheet))
		}
	}
	return (roots, unidentified)
}

struct CapturedWindowImage {
	let image: CGImage
	let windowId: UInt32
	let frame: CGRect
}

// BEGIN PURE (headless_tests.swift links this production file without instantiating Bridge)
/// Native refs for AX windows and elements. Window refs are deduped and live for the process
/// (bounded by the number of windows). Element refs are minted fresh per look: refs owned by a look
/// are dropped when that look ages out (`dropElements(owner:)`); unowned refs (element queries)
/// sit in a FIFO capped at `unownedCapacity`. Every ref carries a per-process epoch, so a ref from
/// a previous helper process can never resolve to another element.
final class AXRefStore {
	struct Snapshot {
		let role: String
		let identifier: String
		let label: String
		let rect: CGRect
	}

	private let unownedCapacity: Int
	private var nextId: UInt64 = 0
	private let epoch = String(UInt32.random(in: 0x1000...0xFFFF_FFFF), radix: 16)
	private var windows: [String: AXUIElement] = [:]
	private var elements: [String: AXUIElement] = [:]
	private var snapshots: [String: Snapshot] = [:]
	private var refsByOwner: [String: [String]] = [:]
	private var unowned: [String] = []
	private let lock = NSLock()

	init(unownedCapacity: Int = 1024) {
		self.unownedCapacity = unownedCapacity
	}

	func storeWindow(_ window: AXUIElement) -> String {
		lock.lock()
		defer { lock.unlock() }
		for (ref, existing) in windows {
			if CFEqual(existing, window) {
				return ref
			}
		}
		nextId += 1
		let ref = "w\(epoch)-\(nextId)"
		windows[ref] = window
		return ref
	}

	func storeElement(_ element: AXUIElement, snapshot: Snapshot? = nil, owner: String? = nil) -> String {
		lock.lock()
		defer { lock.unlock() }
		nextId += 1
		let ref = "e\(epoch)-\(nextId)"
		elements[ref] = element
		snapshots[ref] = snapshot
		if let owner {
			refsByOwner[owner, default: []].append(ref)
		} else {
			unowned.append(ref)
			if unowned.count > unownedCapacity {
				let evicted = unowned.prefix(unowned.count - unownedCapacity)
				for old in evicted { removeElement(old) }
				unowned.removeFirst(evicted.count)
			}
		}
		return ref
	}

	/// Hand `from`'s element refs to `to`. An incremental look (`expand_ui` graft on a base look) keeps
	/// using the base look's refs outside the grafted subtree, so they must live as long as the new look.
	func transferElements(from: String, to: String) {
		guard from != to else { return }
		lock.lock()
		defer { lock.unlock() }
		guard let moved = refsByOwner.removeValue(forKey: from) else { return }
		refsByOwner[to, default: []].append(contentsOf: moved)
	}

	/// Forget every element ref minted for `owner` (a look that aged out or failed).
	func dropElements(owner: String) {
		lock.lock()
		defer { lock.unlock() }
		for ref in refsByOwner.removeValue(forKey: owner) ?? [] { removeElement(ref) }
	}

	/// Live element ref count (tests and diagnostics).
	var elementCount: Int {
		lock.lock()
		defer { lock.unlock() }
		return elements.count
	}

	private func removeElement(_ ref: String) {
		elements.removeValue(forKey: ref)
		snapshots.removeValue(forKey: ref)
	}

	func window(for ref: String) -> AXUIElement? {
		lock.lock()
		defer { lock.unlock() }
		return windows[ref]
	}

	func element(for ref: String) -> AXUIElement? {
		lock.lock()
		defer { lock.unlock() }
		return elements[ref]
	}

	func snapshot(for ref: String) -> Snapshot? {
		lock.lock()
		defer { lock.unlock() }
		return snapshots[ref]
	}
}

/// Modality of a root. An explicit `AXModal` answer is authoritative: Fusion's nonmodal BROWSER
/// sidebar has subrole AXDialog but AXModal=0. Only when the app does not report `AXModal` at
/// all does a dialog-like role/subrole count (legacy toolkits).
func classifyModal(axModal: Bool?, sheetCount: Int, role: String, subrole: String) -> Bool {
	if sheetCount > 0 || role == "AXSheet" { return true }
	if let axModal { return axModal }
	let text = "\(role) \(subrole)"
	return text.range(of: "dialog", options: [.caseInsensitive]) != nil
		|| text.range(of: "modal", options: [.caseInsensitive]) != nil
}

enum CaptureTarget: Equatable {
	case capture(windowId: UInt32)
	case semanticOnly
	case notCapturable
}

/// Capture is allowed only for a real (positive) CG window id. A root with no pairing may still
/// be observed semantically; a visual request fails rather than capturing some other window.
func resolveCaptureTarget(windowId: UInt32?, wantsImage: Bool) -> CaptureTarget {
	if let windowId, windowId > 0 { return wantsImage ? .capture(windowId: windowId) : .semanticOnly }
	return wantsImage ? .notCapturable : .semanticOnly
}
/// A missing or null wire ID is unpaired; a malformed ID must not trigger fallback.
func checkedWindowId(_ raw: Any?) throws -> UInt32? {
	guard let raw, !(raw is NSNull) else { return nil }
	guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), decimalIsIntegral(value),
		let id = UInt32(exactly: value.doubleValue), id > 0
	else {
		throw BridgeFailure(message: "windowId must be a positive 32-bit unsigned integer", code: "invalid_args")
	}
	return id
}

/// JSONSerialization decodes long decimals (e.g. `4294967295.00000001`) as `NSDecimalNumber`, whose
/// `doubleValue` rounds the fraction away. Check integrality on the decoded decimal digits instead.
/// The decoder keeps 38 significant digits; a fraction beyond that never reaches the helper.
private func decimalIsIntegral(_ value: NSNumber) -> Bool {
	guard let decimal = value as? NSDecimalNumber else { return true }
	var source = decimal.decimalValue
	var integral = Decimal()
	NSDecimalRound(&integral, &source, 0, .plain)
	return !source.isNaN && integral == source
}

/// Only an unqualified request (no id, no ref) may take the app's first window. A ref that no longer
/// resolves must fail instead of silently targeting some other window.
func allowsFirstWindowFallback(windowId: UInt32?, windowRef: String?) -> Bool {
	windowId == nil && windowRef == nil
}

/// Policy cap, not a representability boundary. Real macOS display arrangements span tens of thousands of
/// points, so a vertex past +/-1e6 is a caller bug. At this size every vertex keeps sub-point precision in
/// the Float AX hit test (24-bit mantissa), and 1024 vertices keep the summed path length far from overflow.
private let dragCoordinateLimit = 1_000_000

private func validateDragPoint(_ point: CGPoint) throws {
	let limit = CGFloat(dragCoordinateLimit)
	guard abs(point.x) <= limit, abs(point.y) <= limit else {
		throw BridgeFailure(message: "Drag coordinates must be finite and within +/-\(dragCoordinateLimit)", code: "invalid_args")
	}
}

/// The one drag geometry check behind `act`, `actBatch`, `desktopInput` and the native sink: at least two
/// vertices, each within the coordinate limit, and a finite total length. Returns the interpolation step.
private func admittedDragStep(_ points: [CGPoint]) throws -> CGFloat {
	guard points.count >= 2 else {
		throw BridgeFailure(message: "Drag requires at least two points", code: "invalid_args")
	}
	for point in points { try validateDragPoint(point) }
	// Bounded vertices keep the distance and the capped interpolation count representable.
	var total: CGFloat = 0
	for (start, end) in zip(points, points.dropFirst()) {
		total += hypot(end.x - start.x, end.y - start.y)
	}
	guard total.isFinite else {
		throw BridgeFailure(message: "Drag path geometry must be finite", code: "invalid_args")
	}
	// Widen the usual 12pt step on long paths to keep the drag stream short.
	return max(12, total / 1000)
}

/// Parse a wire drag path and admit its geometry as sent (image pixels for act, global points for desktop).
private func dragRequestPoints(_ raw: Any?) throws -> [CGPoint] {
	guard let path = raw as? [[String: Any]], path.count >= 2 else {
		throw BridgeFailure(message: "Drag requires at least two points", code: "invalid_args")
	}
	let points = try path.map { entry in
		guard let x = (entry["x"] as? NSNumber)?.doubleValue, let y = (entry["y"] as? NSNumber)?.doubleValue else {
			throw BridgeFailure(message: "Drag path entries require x and y", code: "invalid_args")
		}
		return CGPoint(x: x, y: y)
	}
	_ = try admittedDragStep(points)
	return points
}

/// Points along a validated segment, ending at `end`. Aim for `maxStep` spacing, capped at 400 steps.
func interpolatedDragPoints(from start: CGPoint, to end: CGPoint, maxStep: CGFloat) -> [CGPoint] {
	let dx = end.x - start.x
	let dy = end.y - start.y
	let distance = hypot(dx, dy)
	guard distance > 0, maxStep > 0 else { return [end] }
	let steps = Int(max(1, min(400, (distance / maxStep).rounded(.up))))
	return (1...steps).map { index in
		let t = CGFloat(index) / CGFloat(steps)
		if index == steps { return end }
		// Keep each interpolated coordinate within the validated vertex bounds even after rounding.
		return CGPoint(
			x: min(max(start.x + dx * t, min(start.x, end.x)), max(start.x, end.x)),
			y: min(max(start.y + dy * t, min(start.y, end.y)), max(start.y, end.y))
		)
	}
}

/// The US-layout key, plus Shift, that types a character, or nil when the US
/// layout has no direct key for it. The key is a `keyCode` name; whether that
/// key really types the character depends on the active layout.
func usLayoutKeyStroke(for character: String) -> (key: String, shift: Bool)? {
	guard character.count == 1 else { return nil }
	if character >= "a" && character <= "z" { return (character, false) }
	if character >= "A" && character <= "Z" { return (character.lowercased(), true) }
	if character >= "0" && character <= "9" { return (character, false) }
	switch character {
	case " ": return ("space", false)
	case ".", ",", "/", "-", "=", ";", "'", "[", "]", "\\", "`": return (character, false)
	case "_": return ("-", true)
	case "+": return ("=", true)
	case ":": return (";", true)
	case "\"": return ("'", true)
	case "?": return ("/", true)
	case "<": return (",", true)
	case ">": return (".", true)
	default: return nil
	}
}

/// A physical key stroke is only safe when the active input source is a plain
/// keyboard layout, not an input method that composes keys, and that layout
/// produces exactly the intended character for the key.
func physicalKeyStrokeTypes(_ character: String, isKeyboardLayout: Bool, layoutProduces produced: String?) -> Bool {
	isKeyboardLayout && produced == character
}

/// The scroll bar value, 0 at the start and 1 at the end, that moves a scroll
/// area's content by `delta` points. The scrollable range comes from the content
/// length when the area reports it, otherwise from the scroll bar's thumb to
/// track ratio, which equals the viewport to content ratio. Returns nil when the
/// range is unknown or empty, or when the bar is already at the end in the
/// requested direction.
func scrollBarTargetValue(current: Double, delta: Int, viewportLength: Double, contentLength: Double?, thumbLength: Double?, trackLength: Double?) -> Double? {
	guard delta != 0, viewportLength > 0, current.isFinite else { return nil }
	var content = contentLength ?? 0
	if content <= viewportLength, let thumbLength, let trackLength, thumbLength > 0, trackLength > thumbLength {
		content = viewportLength * trackLength / thumbLength
	}
	let range = content - viewportLength
	guard range > 1 else { return nil }
	let clamped = min(1, max(0, current))
	let target = min(1, max(0, clamped + Double(delta) / range))
	return abs(target - clamped) < 0.0001 ? nil : target
}

/// Whether the scroll area found `depthFromStart` parents above the target may be moved by writing its scroll
/// bar. Only the area itself, its direct child (content view) or an area an AX hit test at the scroll point
/// resolves to qualifies: a farther outer area would otherwise scroll in place of an inner wheel-scrollable
/// region that exposes no AX scroll action.
func scrollBarWriteAllowed(depthFromStart: Int, hitTestResolvesToArea: Bool) -> Bool {
	depthFromStart <= 1 || hitTestResolvesToArea
}

/// What a scroll bar write did for one axis: `notWritten` (no settable bar, at its end, or the set call failed),
/// `unconfirmed` (the set call succeeded but the immediate read-back still showed the old value, as async apps
/// such as SwiftUI do) or `moved` (the read-back confirmed the move).
enum ScrollAxisWrite {
	case notWritten
	case unconfirmed
	case moved
}

/// The scroll deltas still undelivered after a scroll bar write: an axis keeps its requested delta only when its
/// set call did not succeed. An `unconfirmed` write counts as delivered, because the late bar write lands and a
/// wheel on top of it would scroll twice. A one-axis write never reports the other axis as handled.
func remainingScroll(requestedX: Int, requestedY: Int, x: ScrollAxisWrite, y: ScrollAxisWrite) -> (x: Int, y: Int) {
	(x == .notWritten ? requestedX : 0, y == .notWritten ? requestedY : 0)
}

/// The `CGEvent` wheel counts for a scroll request in the AX/scroll-bar convention (`scrollY > 0` is down,
/// `scrollX > 0` is right). A positive wheel1 scrolls content up and a positive wheel2 scrolls content right
/// (the view moves left), so both axes are negated. Deltas clamp to the symmetric `Int32` range first, so
/// negating and narrowing an extreme request cannot trap the helper.
func scrollWheelCounts(deltaX: Int, deltaY: Int) -> (wheel1: Int32, wheel2: Int32) {
	let bound = Int(Int32.max)
	func wheel(_ delta: Int) -> Int32 { Int32(-min(bound, max(-bound, delta))) }
	return (wheel(deltaY), wheel(deltaX))
}

/// Whether every written axis was confirmed by its read-back; an `unconfirmed` write can only be `unknown`.
func scrollWritesConfirmed(x: ScrollAxisWrite, y: ScrollAxisWrite) -> Bool {
	x != .unconfirmed && y != .unconfirmed
}
/// System authentication agents the helper refuses regardless of the request's list. Mirrors
/// `ALWAYS_BLOCKED_BUNDLE_IDS` in `src/config.ts` (pinned by `test/app-policy.test.mjs`).
let alwaysBlockedBundleIds: [String] = [
	"com.apple.SecurityAgent",
	"com.apple.loginwindow",
	"com.apple.coreservices.uiagent",
	"com.apple.ScreenSaver.Engine",
	"com.apple.LocalAuthenticationRemoteService",
]

/// The request's `blockedBundleIds` (sent by the TypeScript policy) plus the always-blocked agents.
func blockedBundleIdList(_ request: [String: Any]) -> [String] {
	alwaysBlockedBundleIds + ((request["blockedBundleIds"] as? [Any]) ?? []).compactMap { $0 as? String }
}

/// Whether `bundleId` is on the list (case-insensitive). An app without a bundle id never matches.
func isBlockedBundleId(_ bundleId: String?, blocked: [String]) -> Bool {
	guard let bundleId, !bundleId.isEmpty else { return false }
	return blocked.contains { $0.caseInsensitiveCompare(bundleId) == .orderedSame }
}

/// Whether the console session is locked, from `CGSessionCopyCurrentDictionary()`. `CGSSessionScreenIsLocked`
/// is set while the lock screen is up; a session that is not on the console (fast user switch) is unusable for
/// UI work too. No dictionary means no window-server session at all, where UI commands fail by themselves.
func sessionIsLocked(_ session: [String: Any]?) -> Bool {
	guard let session else { return false }
	if (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue == true { return true }
	if let onConsole = (session["kCGSSessionOnConsoleKey"] as? NSNumber)?.boolValue, !onConsole { return true }
	return false
}

/// Commands that read or drive the UI and therefore fail with `screen_locked` while the session is locked.
/// Discovery (`listApps`/`listRoots`/`getFrontmost`), diagnostics, permissions and shutdown stay available.
func commandRequiresUnlockedSession(_ cmd: String) -> Bool {
	["look", "act", "actBatch", "hitTest", "axWaitFor", "axReadText", "focusedElement", "focusWindow", "setWindowFrame", "captureDisplay", "desktopInput"].contains(cmd)
}

/// Message for an `app_blocked` refusal; the TypeScript layer words its own the same way.
func appBlockedMessage(_ name: String, _ bundleId: String?) -> String {
	"app_blocked: '\(name)' (\(bundleId ?? "unknown bundle id")) is blocked by pi-computer-use policy; adjust blocked_apps to allow it (system authentication agents are always blocked)"
}

/// The refusal `handleRequest` throws for `cmd` given the session dictionary, or nil when the command may run.
func lockedSessionRefusal(cmd: String, session: [String: Any]?) -> (code: String, message: String)? {
	guard commandRequiresUnlockedSession(cmd), sessionIsLocked(session) else { return nil }
	return ("screen_locked", "screen_locked: the macOS session is locked, so '\(cmd)' is refused until it is unlocked")
}

/// Items whose bundle id is on the blocklist (case-insensitive), e.g. the `SCRunningApplication`s a display
/// capture must exclude so a blocked app's pixels never reach the model.
func itemsWithBlockedBundleId<T>(_ items: [T], blocked: [String], bundleId: (T) -> String?) -> [T] {
	items.filter { isBlockedBundleId(bundleId($0), blocked: blocked) }
}

/// Use one inventory for both display selection and app exclusions, including apps with off-screen windows.
func displayCaptureContent<Content, App>(
	blocked: [String],
	fetch: (_ excludeDesktopWindows: Bool, _ onScreenWindowsOnly: Bool) async throws -> Content,
	applications: KeyPath<Content, [App]>,
	bundleId: KeyPath<App, String>
) async throws -> (Content, [App]) {
	let content = try await fetch(false, false)
	return (content, itemsWithBlockedBundleId(content[keyPath: applications], blocked: blocked) { $0[keyPath: bundleId] })
}

/// The blocked pid that keyboard input would reach: the frontmost app's, or the system-wide focused app's (a
/// non-activating panel of a blocked app can hold key focus while another app is frontmost). nil when neither
/// resolves to a blocked pid; an unknown focused app falls back to the frontmost check alone.
func keyboardTargetRefusalPid(frontmostPid: Int32?, focusedPid: Int32?, isBlockedPid: (Int32) -> Bool) -> Int32? {
	if let frontmostPid, isBlockedPid(frontmostPid) { return frontmostPid }
	if let focusedPid, isBlockedPid(focusedPid) { return focusedPid }
	return nil
}

/// Probe AX first: it may stall while the frontmost app changes.
func sampleKeyboardTargets(frontmostPid: () -> Int32?, focusedPid: () -> Int32?) -> (Int32?, Int32?) {
	let focused = focusedPid()
	return (frontmostPid(), focused)
}

/// The blocked pid a pointer event at `point` would reach: a blocked window above the first normal-layer window
/// (`blockedWindowOwnerPid`), or the pid of the accessibility hit (`hitPid`, ignoring `excludingPid`), or nil.
func coordinateTargetRefusalPid(windows: [[String: Any]], at point: CGPoint, hitPid: Int32?, excludingPid: Int32, isBlockedPid: (Int32) -> Bool) -> Int32? {
	if let pid = blockedWindowOwnerPid(windows, at: point, excludingPid: excludingPid, isBlockedPid: isBlockedPid) { return pid }
	if let hitPid, hitPid != excludingPid, isBlockedPid(hitPid) { return hitPid }
	return nil
}

/// A blocked owner pid among the windows at `point`, from `CGWindowListCopyWindowInfo` entries (ordered front
/// to back), or nil. Windows of `excludingPid` (our own click-through overlays) and fully transparent or empty
/// windows are skipped. The scan refuses a blocked window anywhere above the first non-blocked normal-layer
/// (layer 0) window containing the point, so a click-through overlay from another app (any layer above 0) cannot
/// hide a blocked window beneath it; a normal-layer window of an unblocked app ends the scan.
func blockedWindowOwnerPid(_ windows: [[String: Any]], at point: CGPoint, excludingPid: Int32, isBlockedPid: (Int32) -> Bool) -> Int32? {
	for window in windows {
		guard let pid = (window["kCGWindowOwnerPID"] as? NSNumber)?.int32Value, pid != excludingPid else { continue }
		if let alpha = (window["kCGWindowAlpha"] as? NSNumber)?.doubleValue, alpha <= 0.01 { continue }
		guard let bounds = window["kCGWindowBounds"] as? [String: Any],
			let x = (bounds["X"] as? NSNumber)?.doubleValue, let y = (bounds["Y"] as? NSNumber)?.doubleValue,
			let w = (bounds["Width"] as? NSNumber)?.doubleValue, let h = (bounds["Height"] as? NSNumber)?.doubleValue,
			w > 0, h > 0 else { continue }
		guard point.x >= x, point.x < x + w, point.y >= y, point.y < y + h else { continue }
		if isBlockedPid(pid) { return pid }
		if ((window["kCGWindowLayer"] as? NSNumber)?.intValue ?? 0) == 0 { return nil }
	}
	return nil
}

/// Whether `act` runs the blocked-window pointer check for a delivery mode. Pid delivery targets one app whose
/// root window is already checked on the TypeScript side, so a host terminal covering the point must not refuse it;
/// only HID events land on whatever is at the point.
func actPointerRefusalApplies(delivery: String) -> Bool {
	delivery == "hid"
}

/// The vertex indices that also get the accessibility hit test: the endpoints. Interior vertices are checked
/// against the single window-list snapshot only.
func hitTestVertexIndices(count: Int) -> Set<Int> {
	count <= 0 ? [] : [0, count - 1]
}

/// Whether keyboard focus has moved to `targetPid`: it is frontmost and, when the AX focused app is known, focused.
func targetHoldsFocus(frontmostPid: Int32?, focusedPid: @autoclosure () -> Int32?, targetPid: Int32) -> Bool {
	guard frontmostPid == targetPid else { return false }
	// Only ask AX once the cheap frontmost check passes; a hung focused app can stall an AX call.
	let focused = focusedPid()
	return focused == nil || focused == targetPid
}

/// Polls `holdsFocus` in `stepMs` sleeps (checking once first) until it holds or `maxMs` of wall time (`nowMs`) pass.
func waitForFocus(maxMs: Int, stepMs: Int, holdsFocus: () -> Bool, sleepMs: (Int) -> Void, nowMs: () -> Int) -> Bool {
	let deadline = nowMs() + maxMs
	while true {
		if holdsFocus() { return true }
		if nowMs() >= deadline { return false }
		sleepMs(stepMs)
	}
}
/// Why `selectText` cannot place a selection of `length` UTF-16 units at `start`, or nil when it can.
/// `valueLength` is the element's current text length in UTF-16 units, nil when the value is not readable
/// (the range is then left for the element to accept or refuse).
func selectionRangeIssue(start: Int, length: Int, valueLength: Int?) -> String? {
	if start < 0 || length < 0 { return "selectText start and length must be non-negative" }
	guard let valueLength else { return nil }
	if start > valueLength || length > valueLength - start {
		return "selectText range \(start)+\(length) is outside the text (\(valueLength) UTF-16 units)"
	}
	return nil
}

/// `paste` restores the user's clipboard only while nothing else has written to it since the temporary write
/// (`changeCount` fence). A newer write, by the user or another app, is never overwritten.
func clipboardRestoreIsSafe(changeCountAfterWrite: Int, changeCountNow: Int) -> Bool {
	changeCountAfterWrite == changeCountNow
}

/// Outcome of a `paste`: the target's value changing proves it landed. Anything else is `unknown`, never `didnt`:
/// a slow target can still read the pasteboard after the deadline, so a "failed" paste must not be retried.
func pasteOutcome(valueBefore: String?, valueAfter: String?) -> String {
	guard let valueBefore, let valueAfter else { return "unknown" }
	return valueBefore != valueAfter ? "worked" : "unknown"
}

/// Pasteboard types that make clipboard history managers skip the temporary `paste` item
/// (the nspasteboard.org conventions). `ConcealedType` is always set: the model may paste a secret.
let pasteTransientTypeIdentifiers = ["org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType", "org.nspasteboard.ConcealedType"]

/// Runs `body` between a temporary write and its restore, restoring on every exit: a failed `write`, a throwing
/// `body` (e.g. a refused keystroke) and normal completion. Returns whether the final restore succeeded.
func withRestoredClipboard(write: () throws -> Void, restore: () -> Bool, body: () throws -> Void) throws -> Bool {
	do {
		try write()
		try body()
	} catch {
		_ = restore()
		throw error
	}
	return restore()
}

/// `secondaryAction` may be re-performed on a refreshed element only when the first attempt hit a dead element;
/// any other failure (e.g. a timeout after AXShowMenu opened the menu) could run the action twice.
func secondaryActionRetryIsSafe(axError: Int32) -> Bool {
	axError == AXError.invalidUIElement.rawValue
}

/// A failed `AXPress` establishes non-delivery only for a dead element or an action the element, API or app refused.
/// `cannotComplete` (the app did not answer in time), `failure` and anything else may have pressed, so `press` never
/// re-presses on a refreshed element or falls back to a pointer click after them: that could press twice (#1240).
func axPressNotDelivered(axError: Int32) -> Bool {
	[AXError.invalidUIElement, .actionUnsupported, .illegalArgument, .apiDisabled, .notImplemented].map(\.rawValue).contains(axError)
}

/// A step that may have delivered its input without proof (`evidence.deliveryUnknown`): a batch must stop there, so a
/// later step neither runs on an unknown state nor hides it (#1240). A generic `unknown` does not stop the batch.
func stepDeliveryUnknown(_ step: [String: Any]) -> Bool {
	(step["evidence"] as? [String: Any])?["deliveryUnknown"] as? Bool == true
}

/// A failed `secondaryAction`: `cannotComplete` (the app did not answer in time) may have run it anyway.
func secondaryActionFailureOutcome(axError: Int32) -> String {
	axError == AXError.cannotComplete.rawValue ? "unknown" : "didnt"
}

/// `selectText` outcome from the range read back after the write: a match proves it, a different range means
/// the element rewrote it, no readable range proves nothing.
func selectionOutcome(requested: (location: Int, length: Int), readBack: (location: Int, length: Int)?) -> String {
	guard let readBack else { return "unknown" }
	return readBack.location == requested.location && readBack.length == requested.length ? "worked" : "didnt"
}
// END PURE

// BEGIN KEYBOARD LAYOUT (compiled standalone by test/macos-native-pure.test.mjs; Carbon only)
/// The text a `UCKeyboardLayout` produces for one key press, or nil for a dead
/// key or a key with no output.
func keyboardLayoutCharacter(layoutData: Data, keyCode: UInt16, shift: Bool) -> String? {
	keyboardLayoutCharacter(layoutData: layoutData, keyCode: keyCode, modifierState: shift ? UInt32(shiftKey >> 8) & 0xFF : 0)
}

/// Like the shift overload, with an explicit UCKeyTranslate modifier state (e.g. `(cmdKey >> 8) & 0xFF`).
func keyboardLayoutCharacter(layoutData: Data, keyCode: UInt16, modifierState: UInt32) -> String? {
	layoutData.withUnsafeBytes { raw -> String? in
		guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
		var deadKeyState: UInt32 = 0
		var length = 0
		var characters = [UniChar](repeating: 0, count: 4)
		let status = UCKeyTranslate(layout, keyCode, UInt16(kUCKeyActionDown), modifierState, UInt32(LMGetKbdType()), 0, &deadKeyState, characters.count, &length, &characters)
		guard status == noErr, deadKeyState == 0, length > 0 else { return nil }
		return String(utf16CodeUnits: characters, count: length)
	}
}

/// UCKeyTranslate modifier state for the Command key.
let commandModifierState: UInt32 = UInt32(cmdKey >> 8) & 0xFF

/// The key code whose Command-modified output is `character`, or nil when no key matches. macOS resolves
/// Command shortcuts through the layout's Command key map, not its typing map: on "Dvorak - QWERTY Command" the
/// Command map is QWERTY (cmd+v is key 9), on plain Dvorak it follows the layout, and on Russian, Greek or Hebrew
/// the Command map is Latin even though no key types "v".
func layoutCommandKeyCode(producing character: String, layoutData: Data) -> UInt16? {
	(0..<UInt16(128)).first { keyboardLayoutCharacter(layoutData: layoutData, keyCode: $0, modifierState: commandModifierState) == character }
}

/// The key code `paste` presses with Command to send cmd+v: the layout's Command-map key for "v", else ANSI key
/// code 9, else nil when there is no layout data to trust at all.
func pasteKeyCode(layoutData: Data?) -> UInt16? {
	guard let layoutData else { return nil }
	return layoutCommandKeyCode(producing: "v", layoutData: layoutData) ?? 9
}

struct KeyboardInputSource {
	/// False when the active source is an input method, such as Pinyin, that
	/// intercepts key strokes before they reach the text field.
	let isKeyboardLayout: Bool
	let layoutData: Data?
}

/// Reads the active keyboard input source. Text Input Sources must be queried on
/// the main thread, which runs the AppKit event loop in serve mode.
func currentKeyboardInputSource() -> KeyboardInputSource {
	let read = { () -> KeyboardInputSource in
		guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else {
			return KeyboardInputSource(isKeyboardLayout: false, layoutData: nil)
		}
		var isKeyboardLayout = false
		if let type = TISGetInputSourceProperty(source, kTISPropertyInputSourceType) {
			isKeyboardLayout = (Unmanaged<CFString>.fromOpaque(type).takeUnretainedValue() as String) == (kTISTypeKeyboardLayout as String)
		}
		var layoutData: Data?
		if let layoutSource = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
			let data = TISGetInputSourceProperty(layoutSource, kTISPropertyUnicodeKeyLayoutData) {
			layoutData = Unmanaged<CFData>.fromOpaque(data).takeUnretainedValue() as Data
		}
		return KeyboardInputSource(isKeyboardLayout: isKeyboardLayout, layoutData: layoutData)
	}
	return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
}
// END KEYBOARD LAYOUT

struct LookRecord {
	let lookId: String
	let windowId: UInt32
	/// Native root ref the look was taken from; the only identity for unpaired roots (windowId 0).
	var windowRef: String? = nil
	let windowFrame: CGRect
	let imageWidth: Int
	let imageHeight: Int
	let hasImage: Bool
}

struct ActScrollRequest {
	let targetPid: Int32
	let scrollX: Int
	let scrollY: Int
	let steps: Int
	let point: CGPoint?
}

// True invalidates cached focus after an operation that can stall.
typealias FocusCheck = (Bool) throws -> Void
// The second argument marks a real down, not an early check after a layout query.
typealias BeforeKeyDown = (Bool, Bool) throws -> Void

/// Counts the key pairs one keyboard action posts, so every failure after a posted prefix reports it as
/// `evidence.postedUnits`: admission refusals through `beforeKeyDown`, anything else through `deliver`.
final class KeyboardPostCounter {
	private(set) var postedUnits = 0
	private let check: FocusCheck

	init(_ check: @escaping FocusCheck) {
		self.check = check
	}

	private func withPostedUnits(_ failure: BridgeFailure) -> BridgeFailure {
		var failure = failure
		var evidence = failure.evidence ?? [:]
		evidence["postedUnits"] = postedUnits
		failure.evidence = evidence
		return failure
	}

	/// Admission before each key-down; the second argument marks a real down, which counts once admitted.
	var beforeKeyDown: BeforeKeyDown {
		return { force, posting in
			do {
				try self.check(force)
			} catch let failure as BridgeFailure {
				throw self.withPostedUnits(failure)
			}
			// Posting the down and release cannot throw after admission succeeds.
			if posting { self.postedUnits += 1 }
		}
	}

	/// Runs keyboard delivery; any `BridgeFailure` it throws, e.g. a failed event allocation, carries the count.
	func deliver(_ body: () throws -> Void) throws {
		do {
			try body()
		} catch let failure as BridgeFailure {
			throw withPostedUnits(failure)
		}
	}
}

/// The longest keyboard delivery `desktopInput` allows: its client's own socket timeout is a fixed 30 s.
let desktopInputKeyboardCeiling: TimeInterval = 30

/// The absolute keyboard deadline in `systemUptime` seconds, the boot-relative clock `diagnostics` reports as
/// `uptimeMs`. The client sends `keyboardDeadlineUptimeMs` in that clock, so no wall-clock step can move it.
/// A missing or non-finite deadline falls back to 30 s from `now`. `ceiling` bounds a present one: `desktopInput`
/// passes its client's fixed 30 s; `act` passes nil, because `act_ui` budgets its timeout by text length.
func keyboardDeadline(_ request: [String: Any], now: TimeInterval, ceiling: TimeInterval?) -> TimeInterval {
	guard let ms = (request["keyboardDeadlineUptimeMs"] as? NSNumber)?.doubleValue, ms.isFinite else { return now + 30 }
	guard let ceiling else { return ms / 1000 }
	return min(ms / 1000, now + ceiling)
}

final class KeyboardAdmission {
	private var lastProbe: TimeInterval = -.infinity
	private var probedFrontmost: Int32?
	private var unitsSinceProbe = 0
	private let now: () -> TimeInterval
	private let deadline: TimeInterval

	init(now: @escaping () -> TimeInterval, deadline: TimeInterval) {
		self.now = now
		self.deadline = deadline
	}

	func checkDeadline() throws {
		if now() >= deadline {
			throw BridgeFailure(message: "Keyboard delivery deadline expired", code: "input_deadline_expired")
		}
	}

	func check(force: Bool, frontmostPid: () -> Int32?, focusedPid: () -> Int32?, refuse: (Int32) throws -> Void) throws {
		try checkDeadline()
		let frontmost = frontmostPid()
		if let frontmost { try refuse(frontmost) }
		if force || frontmost == nil || frontmost != probedFrontmost || unitsSinceProbe >= 8 || now() - lastProbe >= 0.064 {
			let (freshFrontmost, focused) = sampleKeyboardTargets(frontmostPid: frontmostPid, focusedPid: focusedPid)
			if let freshFrontmost { try refuse(freshFrontmost) }
			if let focused, focused != freshFrontmost { try refuse(focused) }
			// An unknown or disagreeing AX target is not a cache hit on the next unit.
			probedFrontmost = focused == frontmost && frontmost == freshFrontmost ? freshFrontmost : nil
			lastProbe = now()
			unitsSinceProbe = 0
		}
		try checkDeadline()
		if !force { unitsSinceProbe += 1 }
	}
}

/// Native boundaries for an action. The headless world supplies every operation, with no live fallback.
struct ActWorld {
	typealias ScrollBarWrite = (value: Double?, remainingX: Int, remainingY: Int, confirmed: Bool)
	let lookRecord: (String) -> LookRecord?
	let cachedElement: (String) -> AXUIElement?
	let refindElement: (String, Int32, UInt32?, String?) -> AXUIElement?
	let copyAttribute: (AXUIElement, CFString) -> CFTypeRef?
	let stringAttribute: (AXUIElement, CFString) -> String?
	let frame: (AXUIElement) -> CGRect?
	let hasAncestorRole: (AXUIElement, String) -> Bool
	let supportsAction: (AXUIElement, CFString) -> Bool
	let performAction: (AXUIElement, CFString) -> AXError
	let setAttribute: (AXUIElement, CFString, CFTypeRef) -> AXError
	let hitTest: (CGPoint) -> AXUIElement?
	let sameElement: (AXUIElement, AXUIElement) -> Bool
	let isDescendant: (AXUIElement, AXUIElement) -> Bool
	let describeElement: (AXUIElement) -> String
	let sheetCount: (Int32, LookRecord) -> Int?
	let focusedWindow: (Int32) -> String
	let activateIfInactive: (Int32) -> Bool?
	let raiseWindow: (Int32, LookRecord) -> Bool?
	let animateCursor: (CGPoint, UInt32) -> Void
	let requireTargetFocus: (Int32) throws -> Void
	let keyboardAdmission: ([String]?, TimeInterval) -> FocusCheck
	let refuseBlockedPoints: ([CGPoint], [String]) throws -> Void
	let beginRootDelta: (Int32) -> ([String: Any]) -> [String: Any]
	let lockInput: () -> Void
	let unlockInput: () -> Void
	let sleep: (useconds_t) -> Void
	let scrollSignature: (AXUIElement) -> String
	let scrollAction: (AXUIElement, ActScrollRequest) -> [String: Any]
	let scrollBar: (AXUIElement, ActScrollRequest) -> ScrollBarWrite?
	let postMouseClick: (CGPoint, Int32, CGMouseButton, Int, String) throws -> Void
	let postMouseMove: (CGPoint, Int32, String) throws -> Void
	let postScrollWheel: (CGPoint, Int, Int, Int32, String) throws -> Void
	let postMouseDrag: ([CGPoint], Int32, String) throws -> Void
	let postKeyPress: ([String], Int32, String, BeforeKeyDown) throws -> Void
	let postKeyCode: (CGKeyCode, CGEventFlags, Int32, String, BeforeKeyDown) throws -> Void
	let postUnicodeText: (String, Int32, String, BeforeKeyDown) throws -> Void
	let postAtomicUnicodeText: (String, Int32, String, BeforeKeyDown) throws -> Void
	let snapshotClipboard: (String) -> (write: () throws -> Void, restore: () -> Bool)
	let pasteKeyCode: () -> UInt16?
}

/// AX reads and writes for scroll traversal. The traversal owns ancestry and PID checks.
struct AXScrollWorld {
	let pid: (AXUIElement) -> Int32?
	let parent: (AXUIElement) -> AXUIElement?
	let supportsAction: (AXUIElement, CFString) -> Bool
	let performAction: (AXUIElement, CFString) -> AXError
	let role: (AXUIElement) -> String?
	let hitTest: (CGPoint, Int32?) -> AXUIElement?
	let sameElement: (AXUIElement, AXUIElement) -> Bool
	let writeBar: (AXUIElement, String, Int, Bool) -> (write: ScrollAxisWrite, value: Double?)
}

/// Event creation and delivery boundaries; the sequencer still owns ordering and delays.
struct NativeInputSink {
	let mouseEvent: (CGEventType, CGPoint, CGMouseButton) -> CGEvent?
	let wheelEvent: (Int32, Int32) -> CGEvent?
	let keyEvent: (CGKeyCode, Bool) -> CGEvent?
	let postToPid: (CGEvent, Int32) -> Void
	let prepareHID: (Int32) -> Bool
	let postHID: (CGEvent, Int32) -> Void
	let sleep: (useconds_t) -> Void
	let keyboardInputSource: () -> KeyboardInputSource
	var checkCancellation: (() throws -> Void)?
	/// Post-time stamp for pointer events, in `CGEventTimestamp` units (nanoseconds since startup, paused in sleep).
	/// No default: every sink, including test fakes, names its clock.
	let eventTimestamp: () -> CGEventTimestamp

	func checkDragCancellation() throws {
		try Task.checkCancellation()
		try checkCancellation?()
	}

	static func createMouseEvent(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton) -> CGEvent? {
		CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)
	}

	static func createWheelEvent(_ vertical: Int32, _ horizontal: Int32) -> CGEvent? {
		CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0)
	}

	static func createKeyEvent(_ code: CGKeyCode, _ down: Bool) -> CGEvent? {
		CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
	}

	/// Activates `pid` when it is not already active; true when it asked for activation.
	static func activateIfInactive(_ pid: Int32) -> Bool {
		guard let app = NSRunningApplication(processIdentifier: pid), !app.isActive else { return false }
		if #available(macOS 14.0, *) {
			_ = app.activate()
		} else {
			_ = app.activate(options: [.activateIgnoringOtherApps])
		}
		return true
	}

	/// The production HID wiring over its three OS effects, injected one by one so tests run the real ordering:
	/// an activation settles for 20 ms before admission, and the final post adds no wait of its own.
	static func production(activate: @escaping (Int32) -> Bool, sleep: @escaping (useconds_t) -> Void, post: @escaping (CGEvent) -> Void) -> NativeInputSink {
		NativeInputSink(
			mouseEvent: createMouseEvent,
			wheelEvent: createWheelEvent,
			keyEvent: createKeyEvent,
			postToPid: { $0.postToPid($1) },
			prepareHID: { pid in
				// AppKit mouseDown handlers can ignore pid-targeted CGEvents. Keep the
				// target frontmost when posting at the HID event tap instead.
				guard activate(pid) else { return false }
				sleep(20_000)
				return true
			},
			postHID: { event, _ in post(event) },
			sleep: sleep,
			keyboardInputSource: currentKeyboardInputSource,
			eventTimestamp: { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }
		)
	}

	static let live = production(activate: activateIfInactive, sleep: { _ = usleep($0) }, post: { $0.post(tap: .cghidEventTap) })
}

/// The clock and blocking calls behind `Bridge.waitForRootChange`, injectable so tests observe the bound
/// without sleeping.
struct RootChangeWaiter {
	let now: () -> Date
	let sleep: (TimeInterval) -> Void
	/// Wait on a locked condition until a deadline.
	let wait: (NSCondition, Date) -> Void

	static let live = RootChangeWaiter(now: { Date() }, sleep: { Thread.sleep(forTimeInterval: $0) }, wait: { _ = $0.wait(until: $1) })
}

struct RootAXEvent {
	let sequence: UInt64
	let timestamp: TimeInterval
	let notification: String
	let element: AXUIElement?
}

/// One observed root's event log. Only the observer's identity is kept: `recordRootAXEvent` routes a
/// callback to its log by `CFEqual` on it.
final class RootAXObserverState {
	let pid: Int32
	let observer: CFTypeRef
	let change = NSCondition()
	var changeGeneration: UInt64 = 0
	var events: [RootAXEvent] = []
	var nextSequence: UInt64 = 1
	var lastUsed: TimeInterval = Date().timeIntervalSince1970

	init(pid: Int32, observer: CFTypeRef) {
		self.pid = pid
		self.observer = observer
	}
}

struct OCRBox {
	let string: String
	let confidence: Double
	let rect: CGRect
}

final class LookNode {
	let element: AXUIElement?
	let ref: String
	let role: String
	let subrole: String
	let identifier: String
	let title: String
	let description: String
	let value: String
	let actions: [String]
	let canPress: Bool
	let canFocus: Bool
	let canSetValue: Bool
	let canScroll: Bool
	let canIncrement: Bool
	let canDecrement: Bool
	let isTextInput: Bool
	let rect: CGRect
	let focused: Bool
	var offscreen: Bool
	var pictureOnly: Bool
	var truncated: Bool
	var scrollExtent: [String: Int]?
	var text: [[String: Any]]
	var children: [LookNode]

	init(element: AXUIElement?, ref: String, role: String, subrole: String, identifier: String, title: String, description: String, value: String, actions: [String], canPress: Bool, canFocus: Bool, canSetValue: Bool, canScroll: Bool, canIncrement: Bool, canDecrement: Bool, isTextInput: Bool, rect: CGRect, focused: Bool = false, offscreen: Bool = false, pictureOnly: Bool = false) {
		self.element = element
		self.ref = ref
		self.role = role
		self.subrole = subrole
		self.identifier = identifier
		self.title = title
		self.description = description
		self.value = value
		self.actions = actions
		self.canPress = canPress
		self.canFocus = canFocus
		self.canSetValue = canSetValue
		self.canScroll = canScroll
		self.canIncrement = canIncrement
		self.canDecrement = canDecrement
		self.isTextInput = isTextInput
		self.rect = rect
		self.focused = focused
		self.offscreen = offscreen
		self.pictureOnly = pictureOnly
		self.truncated = false
		self.text = []
		self.children = []
	}

	func payload() -> [String: Any] {
		var output: [String: Any] = [
			"ref": ref,
			"role": role,
			"subrole": subrole,
			"identifier": identifier,
			"title": title,
			"description": description,
			"value": value,
			"actions": actions,
			"canPress": canPress,
			"canFocus": canFocus,
			"canSetValue": canSetValue,
			"canScroll": canScroll,
			"canIncrement": canIncrement,
			"canDecrement": canDecrement,
			"isTextInput": isTextInput,
			"rect": ["x": rect.origin.x, "y": rect.origin.y, "w": rect.width, "h": rect.height],
			"children": children.map { $0.payload() },
		]
		if focused { output["focused"] = true }
		if offscreen { output["offscreen"] = true }
		if pictureOnly { output["pictureOnly"] = true }
		if truncated { output["truncated"] = true }
		if let scrollExtent { output["scrollExtent"] = scrollExtent }
		if !text.isEmpty { output["text"] = text }
		return output
	}

}

final class Box<T> {
	var value: T
	init(_ value: T) {
		self.value = value
	}
}

/// A disabled tap is re-enabled, and its notification is passed through rather than swallowed.
func suppressionTapShouldReenable(_ type: CGEventType) -> Bool {
	type == .tapDisabledByTimeout || type == .tapDisabledByUserInput
}

final class InputSuppressionGuard {
	static let maxSuppressionSeconds: TimeInterval = 30

	private let lock = NSLock()
	private var eventTap: CFMachPort?
	private var eventTapSource: CFRunLoopSource?
	private var tapRunLoop: CFRunLoop?
	private var tapThread: Thread?

	func begin() throws {
		lock.lock()
		if eventTap != nil {
			lock.unlock()
			return
		}
		lock.unlock()

		let eventTypes: [CGEventType] = [
			.keyDown,
			.keyUp,
			.flagsChanged,
			.leftMouseDown,
			.leftMouseUp,
			.rightMouseDown,
			.rightMouseUp,
			.otherMouseDown,
			.otherMouseUp,
			.mouseMoved,
			.leftMouseDragged,
			.rightMouseDragged,
			.otherMouseDragged,
			.scrollWheel,
			.tabletPointer,
			.tabletProximity,
		]
		let mask = eventTypes.reduce(CGEventMask(0)) { partial, type in
			partial | (CGEventMask(1) << CGEventMask(type.rawValue))
		}

		let callback: CGEventTapCallBack = { _proxy, type, event, userInfo in
			guard let userInfo else { return Unmanaged.passUnretained(event) }
			let inputGuard = Unmanaged<InputSuppressionGuard>.fromOpaque(userInfo).takeUnretainedValue()
			if suppressionTapShouldReenable(type) {
				inputGuard.reenableTap()
				return Unmanaged.passUnretained(event)
			}
			return nil
		}

		guard let tap = CGEvent.tapCreate(
			tap: .cgSessionEventTap,
			place: .headInsertEventTap,
			options: .defaultTap,
			eventsOfInterest: mask,
			callback: callback,
			// passUnretained is only safe because Bridge owns this guard for the
			// whole process lifetime; do not give it a shorter-lived owner.
			userInfo: UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
		) else {
			throw BridgeFailure(message: "Failed to create input suppression event tap", code: "input_suppression_unavailable")
		}

		lock.lock()
		eventTap = tap
		lock.unlock()
		let thread = Thread { [weak self] in
			guard let self else { return }
			let runLoop = CFRunLoopGetCurrent()
			self.lock.lock()
			self.tapRunLoop = runLoop
			self.eventTapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
			if let source = self.eventTapSource {
				CFRunLoopAddSource(runLoop, source, .commonModes)
			}
			// Watchdog: if end() never arrives (e.g. the parent process hangs
			// mid-action), release the tap so the user is not locked out of
			// keyboard and mouse input indefinitely.
			let watchdog = CFRunLoopTimerCreateWithHandler(
				kCFAllocatorDefault,
				CFAbsoluteTimeGetCurrent() + InputSuppressionGuard.maxSuppressionSeconds,
				0,
				0,
				0
			) { [weak self] _ in
				self?.end()
			}
			if let watchdog {
				CFRunLoopAddTimer(runLoop, watchdog, .commonModes)
			}
			CGEvent.tapEnable(tap: tap, enable: true)
			self.lock.unlock()
			CFRunLoopRun()
		}
		thread.name = "pi-computer-use-input-suppression"
		lock.lock()
		tapThread = thread
		lock.unlock()
		thread.start()

		let deadline = Date().addingTimeInterval(1.0)
		while tapRunLoop == nil && Date() < deadline {
			Thread.sleep(forTimeInterval: 0.01)
		}
		if tapRunLoop == nil {
			end()
			throw BridgeFailure(message: "Timed out starting input suppression", code: "input_suppression_timeout")
		}
	}

	func end() {
		lock.lock()
		let tap = eventTap
		let source = eventTapSource
		let runLoop = tapRunLoop
		eventTap = nil
		eventTapSource = nil
		tapRunLoop = nil
		tapThread = nil
		lock.unlock()

		if let tap {
			CGEvent.tapEnable(tap: tap, enable: false)
		}
		if let source, let runLoop {
			CFRunLoopRemoveSource(runLoop, source, .commonModes)
			CFRunLoopStop(runLoop)
		}
	}

	func reenableTap() {
		lock.lock()
		let tap = eventTap
		lock.unlock()
		if let tap {
			CGEvent.tapEnable(tap: tap, enable: true)
		}
	}

}

/// Kernel vnode identity (`"<dev>:<ino>"`) of the executable image mapped at `#dsohandle`.
/// Reads the active VM mapping rather than resolving a path on disk, so unlinking or replacing
/// the installed binary leaves a running helper reporting the vnode it launched from.
func mappedExecutableId(
	_ regionInfo: (UInt64, UnsafeMutablePointer<proc_regionwithpathinfo>, Int32) -> Int32 = { address, info, size in
		proc_pidinfo(getpid(), PROC_PIDREGIONPATHINFO, address, info, size)
	}
) -> String? {
	var info = proc_regionwithpathinfo()
	let size = Int32(MemoryLayout<proc_regionwithpathinfo>.stride)
	guard regionInfo(UInt64(UInt(bitPattern: #dsohandle)), &info, size) == size else { return nil }
	let vst = info.prp_vip.vip_vi.vi_stat
	guard vst.vst_ino != 0 else { return nil }
	let dev = UInt64(bitPattern: Int64(Int32(bitPattern: vst.vst_dev)))
	return "\(dev):\(vst.vst_ino)"
}

final class Bridge {
	private let protocolVersion = 8
	private let executableId: String?
	private let refStore: AXRefStore
	private let activityGlow: ActivityGlowController?
	private let inputSuppressionGuard = InputSuppressionGuard()
	private let physicalInputLock: NSLocking
	private let inputSink: NativeInputSink
	private let supportsAgentCursor = CommandLine.arguments.contains("serve")
	private let browserBundleIds: Set<String> = [
		"com.apple.Safari", "com.google.Chrome", "org.chromium.Chromium", "company.thebrowser.Browser", "com.brave.Browser", "com.microsoft.edgemac", "com.vivaldi.Vivaldi", "net.imput.helium", "org.mozilla.firefox",
	]
	private var enhancedAccessibilityPids = Set<Int32>()
	private let enhancedAccessibilityLock = NSLock()
	private var stdinBuffer = Data()
	private let dispatchRequest: (([String: Any], UUID?) throws -> Any)?
	private let readSession: () -> [String: Any]?
	private let writeOutput: (Data) throws -> Void
	private let writeSocket: (Int32, UnsafeRawPointer, Int) -> Int

	/// Narrow IO boundaries; defaults preserve the daemon's real dispatch and transport.
	init(
		activityGlow: ActivityGlowController? = ActivityGlowController(),
		dispatchRequest: (([String: Any], UUID?) throws -> Any)? = nil,
		readSession: @escaping () -> [String: Any]? = { CGSessionCopyCurrentDictionary() as? [String: Any] },
		writeOutput: @escaping (Data) throws -> Void = { try FileHandle.standardOutput.write(contentsOf: $0) },
		writeSocket: @escaping (Int32, UnsafeRawPointer, Int) -> Int = { Darwin.send($0, $1, $2, 0) },
		inputSink: NativeInputSink = .live,
		physicalInputLock: NSLocking = NSRecursiveLock(),
		refStore: AXRefStore = AXRefStore(),
		executableId: String? = mappedExecutableId()
	) {
		self.executableId = executableId
		self.refStore = refStore
		self.activityGlow = activityGlow
		self.inputSink = inputSink
		self.physicalInputLock = physicalInputLock
		self.dispatchRequest = dispatchRequest
		self.readSession = readSession
		self.writeOutput = writeOutput
		self.writeSocket = writeSocket
	}
	private var nextLookId: UInt64 = 0
	private var lookRecords: [String: LookRecord] = [:]
	private var lookRecordOrder: [String] = []
	private let lookRecordLock = NSLock()
	private let rootObserverLock = NSLock()
	private var rootObservers: [Int32: RootAXObserverState] = [:]
	private let maxRootObservers = 4
	private let permissionCacheLock = NSLock()
	private var grantedPermissionStatus: [String: Any]?
	private let completedRequestLock = NSLock()
	private var recentCompletedRequestIds: [String] = []

	func run() {
		if CommandLine.arguments.contains("serve") {
			let socketPath = argumentValue("--socket") ?? defaultSocketPath()
			Thread.detachNewThread { [self] in runServer(socketPath: socketPath) }
			NSApp.run()
			return
		}
		while true {
			autoreleasepool {
				let data = FileHandle.standardInput.availableData
				if data.isEmpty {
					exit(0)
				}
				receiveInput(data)
			}
		}
	}

	private func argumentValue(_ name: String) -> String? {
		guard let index = CommandLine.arguments.firstIndex(of: name), CommandLine.arguments.indices.contains(index + 1) else { return nil }
		return CommandLine.arguments[index + 1]
	}

	private func defaultSocketPath() -> String {
		let home = FileManager.default.homeDirectoryForCurrentUser.path
		return "\(home)/Library/Caches/pi-computer-use/bridge.sock"
	}

	private func runServer(socketPath: String) {
		_ = signal(SIGPIPE, SIG_IGN)
		try? FileManager.default.createDirectory(atPath: (socketPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
		// LaunchServices may race multiple `open -n` requests while the first
		// daemon is still binding. Keep process ownership separate from socket
		// cleanup so a late launcher can never unlink the live daemon's socket.
		let lockPath = "\(socketPath).lock"
		let lockFile = open(lockPath, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
		if lockFile < 0 || flock(lockFile, LOCK_EX | LOCK_NB) != 0 {
			if lockFile >= 0 { close(lockFile) }
			exit(0)
		}
		unlink(socketPath)
		let server = socket(AF_UNIX, SOCK_STREAM, 0)
		if server < 0 { close(lockFile); exit(1) }
		var address = sockaddr_un()
		address.sun_family = sa_family_t(AF_UNIX)
		let sunPathCapacity = MemoryLayout.size(ofValue: address.sun_path)
		let bytes = Array(socketPath.utf8.prefix(sunPathCapacity - 1))
		withUnsafeMutablePointer(to: &address.sun_path) { pointer in
			pointer.withMemoryRebound(to: CChar.self, capacity: sunPathCapacity) { dest in
				for (index, byte) in bytes.enumerated() { dest[index] = CChar(bitPattern: byte) }
			}
		}
		let bindStatus = withUnsafePointer(to: &address) { pointer in
			pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
		}
		if bindStatus != 0 || listen(server, 8) != 0 { close(server); close(lockFile); exit(1) }
		while true {
			let client = accept(server, nil, nil)
			if client < 0 { continue }
			var noSigPipe: Int32 = 1
			_ = setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout.size(ofValue: noSigPipe)))
			Thread.detachNewThread { [weak self] in self?.processClient(client) }
		}
	}

	private func processClient(_ client: Int32) {
		let clientID = UUID()
		defer { activityGlow?.disconnect(clientID) }
		let clientInput = FileHandle(fileDescriptor: client, closeOnDealloc: true)
		var buffer = Data()
		let newline = Data([0x0A])
		while true {
			let data = clientInput.availableData
			if data.isEmpty { break }
			buffer.append(data)
			while let range = buffer.range(of: newline) {
				let lineData = buffer.subdata(in: 0..<range.lowerBound)
				buffer.removeSubrange(0..<range.upperBound)
				if let line = String(data: lineData, encoding: .utf8), !line.isEmpty { handleLine(line, to: client, clientID: clientID) }
			}
		}
		clientInput.closeFile()
	}

	/// Append arbitrary byte chunks; incomplete NDJSON frames remain buffered.
	func receiveInput(_ data: Data) {
		stdinBuffer.append(data)
		processBufferedInput()
	}

	private func processBufferedInput() {
		let newline = Data([0x0A])
		while let range = stdinBuffer.range(of: newline) {
			let lineData = stdinBuffer.subdata(in: 0..<range.lowerBound)
			stdinBuffer.removeSubrange(0..<range.upperBound)

			guard !lineData.isEmpty else { continue }
			guard let line = String(data: lineData, encoding: .utf8) else { continue }
			handleLine(line)
		}
	}

	func handleLine(_ line: String, to responseSocket: Int32? = nil, clientID: UUID? = nil) {
		let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return }

		let fallbackId = "invalid"
		var completionId: String?
		defer {
			if responseSocket != nil, let completionId { recordCompletedRequest(completionId) }
		}
		do {
			guard let jsonData = trimmed.data(using: .utf8) else {
				throw BridgeFailure(message: "Input was not valid UTF-8", code: "invalid_request")
			}
			guard let object = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
				throw BridgeFailure(message: "Request must be a JSON object", code: "invalid_request")
			}
			let id = (object["id"] as? String) ?? fallbackId
			completionId = id

			do {
				let result = try dispatchRequest?(object, clientID) ?? handleRequest(object, clientID: clientID)
				send([
					"id": id,
					"ok": true,
					"result": result,
				], to: responseSocket)
			} catch let failure as BridgeFailure {
				send([
					"id": id,
					"ok": false,
					"error": failure.wireError,
				], to: responseSocket)
			} catch {
				send([
					"id": id,
					"ok": false,
					"error": [
						"message": error.localizedDescription,
						"code": "internal_error",
					],
				], to: responseSocket)
			}
		} catch let failure as BridgeFailure {
			send([
				"id": fallbackId,
				"ok": false,
				"error": failure.wireError,
			], to: responseSocket)
		} catch {
			send([
				"id": fallbackId,
				"ok": false,
				"error": [
					"message": error.localizedDescription,
					"code": "internal_error",
				],
			], to: responseSocket)
		}
	}

	func send(_ payload: [String: Any], to responseSocket: Int32? = nil) {
		guard JSONSerialization.isValidJSONObject(payload),
			let data = try? JSONSerialization.data(withJSONObject: payload),
			let line = String(data: data, encoding: .utf8),
			let out = (line + "\n").data(using: .utf8)
		else {
			return
		}

		guard let responseSocket else {
			try? writeOutput(out)
			return
		}
		out.withUnsafeBytes { raw in
			guard let base = raw.baseAddress else { return }
			var offset = 0
			while offset < raw.count {
				let sent = writeSocket(responseSocket, base.advanced(by: offset), raw.count - offset)
				if sent <= 0 { return }
				offset += sent
			}
		}
	}

	func recordCompletedRequest(_ id: String) {
		completedRequestLock.lock()
		recentCompletedRequestIds.removeAll { $0 == id }
		recentCompletedRequestIds.append(id)
		if recentCompletedRequestIds.count > 32 {
			recentCompletedRequestIds.removeFirst(recentCompletedRequestIds.count - 32)
		}
		completedRequestLock.unlock()
	}

	func completedRequestIds() -> [String] {
		completedRequestLock.lock()
		defer { completedRequestLock.unlock() }
		return recentCompletedRequestIds
	}

	func handleRequest(
		_ request: [String: Any], clientID: UUID?,
		discoverRoots: ((Int32?, String?) throws -> [String: Any])? = nil,
		lookWindowOwner: ((UInt32) -> Int32?)? = nil,
		lookCapture: ((UInt32) throws -> CapturedWindowImage)? = nil
	) throws -> Any {
		let cmd = try stringArg(request, "cmd")
		if let refusal = lockedSessionRefusal(cmd: cmd, session: readSession()) {
			throw BridgeFailure(message: refusal.message, code: refusal.code)
		}

		switch cmd {
		case "diagnostics":
			return diagnostics()
		case "checkPermissions":
			return checkPermissions()
		case "registerPermissions":
			return try registerPermissions()
		case "openPermissionPane":
			return try openPermissionPane(request)
		case "setActivityGlow":
			guard let clientID, let active = boolArg(request, "active") else {
				throw BridgeFailure(message: "Activity glow requires a connected client and boolean 'active' value", code: "invalid_args")
			}
			activityGlow?.setActive(active, for: clientID)
			return ["active": active]
		case "shutdown":
			// Reply first, then exit: the caller relaunches the helper to get a
			// process with a fresh TCC client (grant answers are cached per
			// process, so a helper that saw "denied" keeps answering "denied"
			// after the user grants — only a new process re-queries tccd).
			// Background queue: the serve loop occupies the main thread, so a
			// main-queue timer would never fire.
			DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { exit(0) }
			return ["shuttingDown": true]
		case "listApps":
			return listApps()
		case "listWindows":
			return try listWindows(pid: pidArg(request))
		case "listRoots":
			// Missing, null and nonnumeric filters previously meant broad discovery. Never truncate numeric filters.
			let pid = try request["pid"] is NSNumber ? pidArg(request) : nil
			let title = optionalStringArg(request, "title")
			if let discoverRoots { return try discoverRoots(pid, title) }
			return try listRoots(pid: pid, title: title)
		case "getFrontmost":
			return try getFrontmost()
		case "getUserContext":
			return try getUserContext()
		case "beginInputSuppression":
			return try beginInputSuppression()
		case "endInputSuppression":
			return endInputSuppression()
		case "restoreUserFocus":
			return try restoreUserFocus(request)
		case "focusWindow":
			return try focusWindow(request)
		case "setWindowFrame":
			return try setWindowFrame(request)
		case "look":
			return try look(request, windowOwner: lookWindowOwner ?? pidForWindowId, captureWindow: lookCapture ?? captureWindow)
		case "act":
			return try act(request)
		case "actBatch":
			return try actBatch(request)
		case "hitTest":
			return try hitTest(request)
		case "axWaitFor":
			return try axWaitFor(request)
		case "focusedElement":
			return try focusedElement(request)
		case "axReadText":
			return try axReadText(request)
		case "getMousePosition":
			return getMousePosition()
		case "captureDisplay":
			return try captureDisplay(request)
		case "desktopInput":
			return try desktopInput(request)
		default:
			throw BridgeFailure(message: "Unknown command '\(cmd)'", code: "unknown_command")
		}
	}

	func stringArg(_ request: [String: Any], _ key: String) throws -> String {
		if let value = request[key] as? String {
			return value
		}
		throw BridgeFailure(message: "Missing string argument '\(key)'", code: "invalid_args")
	}

	func optionalStringArg(_ request: [String: Any], _ key: String) -> String? {
		if let value = request[key] as? String {
			return value
		}
		return nil
	}

	func intArg(_ request: [String: Any], _ key: String) throws -> Int {
		if let value = request[key] as? Int {
			return value
		}
		if let value = request[key] as? NSNumber {
			return value.intValue
		}
		if let value = request[key] as? Double {
			return Int(value)
		}
		throw BridgeFailure(message: "Missing integer argument '\(key)'", code: "invalid_args")
	}

	private func pidArg(_ request: [String: Any]) throws -> Int32 {
		guard let number = request["pid"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
		      let raw = number as? Int, let pid = Int32(exactly: raw), pid > 0 else {
			throw BridgeFailure(message: "pid must be a positive 32-bit integer", code: "invalid_args")
		}
		return pid
	}

	func optionalIntArg(_ request: [String: Any], _ key: String) -> Int? {
		if let value = request[key] as? Int {
			return value
		}
		if let value = request[key] as? NSNumber {
			return value.intValue
		}
		if let value = request[key] as? Double {
			return Int(value)
		}
		return nil
	}

	func boolArg(_ request: [String: Any], _ key: String) -> Bool? {
		if let value = request[key] as? Bool { return value }
		if let value = request[key] as? NSNumber { return value.boolValue }
		return nil
	}

	func doubleArg(_ request: [String: Any], _ key: String) throws -> Double {
		if let value = request[key] as? Double {
			return value
		}
		if let value = request[key] as? NSNumber {
			return value.doubleValue
		}
		if let value = request[key] as? Int {
			return Double(value)
		}
		throw BridgeFailure(message: "Missing numeric argument '\(key)'", code: "invalid_args")
	}

	private func processPath(pid: pid_t) -> String? {
		var buffer = [CChar](repeating: 0, count: 4096)
		let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
		return length > 0 ? String(cString: buffer) : nil
	}

	private func processName(pid: pid_t) -> String? {
		processPath(pid: pid).map { URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent }
	}

	private func diagnostics() -> [String: Any] {
		// Cheap booleans only — diagnostics doubles as the daemon liveness
		// probe (1s client timeout), so it must not run the ScreenCaptureKit
		// capturable check (up to 3s when ungranted). Permission truth comes
		// from checkPermissions.
		let permissions: [String: Any] = [
			"accessibility": AXIsProcessTrusted(),
			"screenRecording": {
				if #available(macOS 10.15, *) { return CGPreflightScreenCaptureAccess() }
				return true
			}(),
		]
		#if arch(arm64)
		let arch = "arm64"
		#elseif arch(x86_64)
		let arch = "x86_64"
		#else
		let arch = "unknown"
		#endif
		let parentPid = Int32(getppid())
		let parentApp = NSRunningApplication(processIdentifier: parentPid)
		let parentPath = processPath(pid: parentPid)
		var output: [String: Any] = [
			"protocolVersion": protocolVersion,
			"buildIdentity": helperBuildIdentity,
			"architectureVersion": 1,
			"invariants": ["state-scoped-observations", "bounded-observation-history", "multi-root-forest", "progressive-disclosure", "atomic-physical-input", "concurrent-requests", "transactional-batching"],
			"pid": Int32(getpid()),
			"parentPid": parentPid,
			"executablePath": CommandLine.arguments.first ?? "",
			"macOS": ProcessInfo.processInfo.operatingSystemVersionString,
			"arch": arch,
			"accessibility": permissions["accessibility"] ?? false,
			"screenRecording": permissions["screenRecording"] ?? false,
			"activityGlowActive": activityGlow?.isActive ?? false,
			"recentCompletedRequestIds": completedRequestIds(),
			// The boot-relative clock keyboard deadlines are expressed in (see `keyboardDeadline`).
			"uptimeMs": ProcessInfo.processInfo.systemUptime * 1000,
		]
		if let executableId {
			output["executableId"] = executableId
		}
		if let parentPath {
			output["parentPath"] = parentPath
		}
		if let parentAppName = parentApp?.localizedName ?? parentPath.map({ URL(fileURLWithPath: $0).lastPathComponent }) {
			output["parentAppName"] = parentAppName
		}
		if let parentBundleId = parentApp?.bundleIdentifier {
			output["parentBundleId"] = parentBundleId
		}
		return output
	}

	/// Live Screen Recording probe. `CGPreflightScreenCaptureAccess()`
	/// answers from a per-process cache that goes stale after `tccutil
	/// reset` or a Settings toggle; a ScreenCaptureKit content fetch only
	/// succeeds when THIS process can genuinely capture right now. When the
	/// two disagree, the preflight boolean is the one lying.
	private func screenRecordingCapturable() -> Bool {
		if #available(macOS 14.0, *) {
			let sema = DispatchSemaphore(value: 0)
			let capturable = Box<Bool>(false)
			SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { shareable, error in
				if let shareable = shareable {
					capturable.value = !shareable.displays.isEmpty
				}
				sema.signal()
			}
			guard sema.wait(timeout: .now() + .seconds(5)) == .success else { return false }
			return capturable.value
		}
		if #available(macOS 10.15, *) {
			return CGPreflightScreenCaptureAccess()
		}
		return true
	}

	/// Which TCC identity the permission booleans reflect. macOS attributes
	/// grants to the *responsible process* (the LaunchServices launching
	/// app), so:
	///   - "helper-app": running from the installed bundle, launched via
	///     LaunchServices — grants belong to the canonical helper identity.
	///   - "caller": anything else (dev binary under a terminal, etc.) —
	///     the booleans reflect whatever app spawned us, NOT the canonical
	///     helper. The extension surfaces this instead of guessing.
	private func permissionSource() -> [String: Any] {
		let parentPid = Int32(getppid())
		let executable = CommandLine.arguments.first ?? ""
		var source: [String: Any] = [
			"pid": Int(getpid()),
			"parentPid": Int(parentPid),
			"executablePath": executable,
			"macOS": ProcessInfo.processInfo.operatingSystemVersionString,
		]
		if let parentPath = processPath(pid: parentPid) {
			source["parentPath"] = parentPath
		}
		if let parentBundleId = NSRunningApplication(processIdentifier: parentPid)?.bundleIdentifier {
			source["parentBundleId"] = parentBundleId
		}
		let attribution: String
		if executable.contains("/pi-computer-use.app/Contents/MacOS/"), parentPid == 1 {
			// Non-spoofable signals only: installed-bundle executable path +
			// launchd parent (`open` handed us to LaunchServices). A dev
			// binary or a directly-spawned copy fails closed to "caller".
			attribution = "helper-app"
		} else {
			attribution = "caller"
		}
		source["attribution"] = attribution
		return source
	}

	private func checkPermissions() -> [String: Any] {
		permissionCacheLock.lock()
		if let cached = grantedPermissionStatus {
			permissionCacheLock.unlock()
			return cached
		}
		permissionCacheLock.unlock()
		let accessibility = AXIsProcessTrusted()
		let screenRecordingPreflight: Bool
		if #available(macOS 10.15, *) {
			screenRecordingPreflight = CGPreflightScreenCaptureAccess()
		} else {
			screenRecordingPreflight = true
		}
		let capturable = screenRecordingCapturable()
		let result: [String: Any] = [
			"accessibility": accessibility,
			// The live probe is authoritative; the preflight boolean is kept
			// for diagnostics (a true/false split identifies a stale cache or
			// a grant belonging to a different responsible process).
			"screenRecording": capturable,
			"screenRecordingPreflight": screenRecordingPreflight,
			"screenRecordingCapturable": capturable,
			"source": permissionSource(),
		]
		// A successful TCC grant is process-stable in practice. Cache only the
		// positive result so missing grants are always rechecked after the user
		// enables them, while fresh agent processes avoid repeating a multi-second
		// ScreenCaptureKit probe against the same long-lived helper daemon.
		if accessibility && capturable {
			permissionCacheLock.lock()
			grantedPermissionStatus = result
			permissionCacheLock.unlock()
		}
		return result
	}

	/// Register this process's identity with TCC for both grants so the app
	/// appears in the Settings panes BEFORE the user is sent there. The AX
	/// request registers (and prompts for) Accessibility; on recent macOS an
	/// app only appears under Screen Recording after a real ScreenCaptureKit
	/// attempt, which the capturable probe performs.
	private func registerPermissions() throws -> [String: Any] {
		let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
		let accessibility = AXIsProcessTrustedWithOptions(options)
		if #available(macOS 10.15, *) {
			_ = CGRequestScreenCaptureAccess()
		}
		let capturable = screenRecordingCapturable()
		return [
			"accessibility": accessibility,
			"screenRecording": capturable,
			"screenRecordingCapturable": capturable,
		]
	}

	private func openPermissionPane(_ request: [String: Any]) throws -> [String: Any] {
		let kind = try stringArg(request, "kind")
		let urlString: String
		switch kind {
		case "accessibility":
			urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
		case "screenRecording", "screenrecording":
			urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
		default:
			throw BridgeFailure(message: "Unknown permission pane '\(kind)'", code: "invalid_args")
		}

		guard let url = URL(string: urlString) else {
			throw BridgeFailure(message: "Invalid permission pane URL", code: "internal_error")
		}
		let opened = NSWorkspace.shared.open(url)
		return ["opened": opened]
	}

	private func pidIsAlive(_ pid: pid_t) -> Bool {
		pid > 0 && kill(pid, 0) == 0
	}

	private func listApps(cgEntries: [[String: Any]]? = nil) -> [[String: Any]] {
		let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
		let apps = NSWorkspace.shared.runningApplications.filter { app in
			// Computer-use targets are windows, not Dock-visible applications. Some
			// benchmark/test apps and utility-style apps expose perfectly valid AX
			// windows while using an accessory/prohibited activation policy, so do not
			// gate discovery on `.regular` here. `listWindows` and the higher-level
			// window collector filter to actual controllable windows.
			app.processIdentifier != getpid() && pidIsAlive(app.processIdentifier)
		}
		var seen = Set<Int32>()
		var output = apps.map { app in
			seen.insert(app.processIdentifier)
			var data: [String: Any] = [
				"appName": app.localizedName ?? processName(pid: app.processIdentifier) ?? "Unknown App",
				"pid": Int(app.processIdentifier),
				"isFrontmost": app.processIdentifier == frontmostPid,
			]
			if let bundleId = app.bundleIdentifier {
				data["bundleId"] = bundleId
			}
			return data
		}

		// NSWorkspace can miss apps launched from ad-hoc bundles or test harnesses
		// even when their windows are visible and AX-controllable. Add CGWindow
		// owners as acquisition candidates so callers can still resolve by pid/title
		// and then build the normal AX scene through listWindows(pid:).
		for owner in cgWindowOwners(entries: cgEntries) where owner.pid != getpid() && !seen.contains(owner.pid) && pidIsAlive(owner.pid) {
			seen.insert(owner.pid)
			output.append([
				"appName": owner.name,
				"pid": Int(owner.pid),
				"isFrontmost": owner.pid == frontmostPid,
			])
		}
		return output
	}

	private func getFrontmost() throws -> [String: Any] {
		guard let app = NSWorkspace.shared.frontmostApplication else {
			throw BridgeFailure(message: "No frontmost app available", code: "frontmost_unavailable")
		}
		let pid = app.processIdentifier
		let windows = try listWindows(pid: pid)

		var result: [String: Any] = [
			"appName": app.localizedName ?? "Unknown App",
			"pid": Int(pid),
		]
		if let bundleId = app.bundleIdentifier {
			result["bundleId"] = bundleId
		}

		if let chosen = windows.sorted(by: { scoreWindow($0) > scoreWindow($1) }).first {
			result["windowTitle"] = (chosen["title"] as? String) ?? ""
			if let windowId = chosen["windowId"] {
				result["windowId"] = windowId
			}
			if let windowRef = chosen["windowRef"] as? String {
				result["windowRef"] = windowRef
			}
		}
		return result
	}

	private func getUserContext() throws -> [String: Any] {
		guard let app = NSWorkspace.shared.frontmostApplication else {
			throw BridgeFailure(message: "No frontmost app available", code: "frontmost_unavailable")
		}
		let pid = app.processIdentifier
		ensureEnhancedAccessibility(pid: pid)
		let appElement = AXUIElementCreateApplication(pid)
		let focusedWindow = copyAttribute(appElement, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement)
		let focusedElement = copyAttribute(appElement, attribute: kAXFocusedUIElementAttribute as CFString).flatMap(asAXElement)
		var result: [String: Any] = [
			"appName": app.localizedName ?? "Unknown App",
			"pid": Int(pid),
		]
		if let bundleId = app.bundleIdentifier {
			result["bundleId"] = bundleId
		}
		if let window = focusedWindow {
			result["window"] = [
				"title": stringAttribute(window, attribute: kAXTitleAttribute as CFString) ?? "",
				"role": stringAttribute(window, attribute: kAXRoleAttribute as CFString) ?? "",
				"subrole": stringAttribute(window, attribute: kAXSubroleAttribute as CFString) ?? "",
			]
		}
		if let element = focusedElement {
			let focusedRole = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
			let focusedSubrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
			result["focusedElement"] = [
				"role": focusedRole,
				"subrole": focusedSubrole,
				"title": stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? "",
				"description": stringAttribute(element, attribute: kAXDescriptionAttribute as CFString) ?? "",
				"value": displayValue(element, role: focusedRole, subrole: focusedSubrole),
			]
		}
		return result
	}

	private func beginInputSuppression() throws -> [String: Any] {
		try inputSuppressionGuard.begin()
		return ["active": true]
	}

	private func endInputSuppression() -> [String: Any] {
		inputSuppressionGuard.end()
		return ["active": false]
	}

	private func restoreUserFocus(_ request: [String: Any]) throws -> [String: Any] {
		let pid = try pidArg(request)
		let targetTitle = optionalStringArg(request, "windowTitle")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		guard let app = NSRunningApplication(processIdentifier: pid) else {
			throw BridgeFailure(message: "App with pid \(pid) is no longer running", code: "app_not_found")
		}

		let appRestored = app.activate()
		var restoredWindowTitle = ""
		var windowRestored = false

		if !targetTitle.isEmpty {
			let appElement = AXUIElementCreateApplication(pid)
			let windows = axElementArray(appElement, attribute: kAXWindowsAttribute as CFString)
			let normalizedTarget = targetTitle.lowercased()
			if let match = windows.first(where: {
				(stringAttribute($0, attribute: kAXTitleAttribute as CFString) ?? "")
					.trimmingCharacters(in: .whitespacesAndNewlines)
					.lowercased() == normalizedTarget
			}) {
				restoredWindowTitle = stringAttribute(match, attribute: kAXTitleAttribute as CFString) ?? ""
				let setMainStatus = AXUIElementSetAttributeValue(match, kAXMainAttribute as CFString, kCFBooleanTrue)
				let setFocusedStatus = AXUIElementSetAttributeValue(match, kAXFocusedAttribute as CFString, kCFBooleanTrue)
				let raiseStatus = AXUIElementPerformAction(match, kAXRaiseAction as CFString)
				windowRestored = setMainStatus == .success || setFocusedStatus == .success || raiseStatus == .success
			}
		}

		return [
			"restored": appRestored || windowRestored,
			"appRestored": appRestored,
			"windowRestored": windowRestored,
			"appName": app.localizedName ?? "Unknown App",
			"windowTitle": restoredWindowTitle,
		]
	}

	private func setWindowFrame(_ request: [String: Any]) throws -> [String: Any] {
		let pid = try pidArg(request)
		let windowId = try checkedWindowId(request["windowId"])
		let windowRef = optionalStringArg(request, "windowRef")
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			return ["ok": false, "reason": "window_not_found"]
		}
		let x = try doubleArg(request, "x")
		let y = try doubleArg(request, "y")
		let width = max(100.0, try doubleArg(request, "width"))
		let height = max(80.0, try doubleArg(request, "height"))
		var origin = CGPoint(x: x, y: y)
		var size = CGSize(width: width, height: height)
		guard let originValue = AXValueCreate(.cgPoint, &origin), let sizeValue = AXValueCreate(.cgSize, &size) else {
			throw BridgeFailure(message: "Failed to create AX frame values", code: "frame_value_failed")
		}
		let positionStatus = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, originValue)
		let sizeStatus = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue)
		let frame = frameForWindow(window)
		return [
			"ok": positionStatus == .success || sizeStatus == .success,
			"positionStatus": Int(positionStatus.rawValue),
			"sizeStatus": Int(sizeStatus.rawValue),
			"framePoints": ["x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height],
		]
	}

	private func focusWindow(_ request: [String: Any]) throws -> [String: Any] {
		let pid = try pidArg(request)
		let windowId = try checkedWindowId(request["windowId"])
		let windowRef = optionalStringArg(request, "windowRef")
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			return ["focused": false, "reason": "window_not_found"]
		}

		let appElement = AXUIElementCreateApplication(pid)
		if let focusedWindow = copyAttribute(appElement, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement),
			sameElement(focusedWindow, window)
		{
			return ["focused": true, "alreadyFocused": true]
		}

		let setMainStatus = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
		let setFocusedStatus = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
		let raiseStatus = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
		let focused = setMainStatus == .success || setFocusedStatus == .success || raiseStatus == .success
		var result: [String: Any] = [
			"focused": focused,
			"setMain": setMainStatus == .success,
			"setFocused": setFocusedStatus == .success,
			"raised": raiseStatus == .success,
		]
		if !focused {
			result["reason"] = "focus_failed"
		}
		return result
	}

	func scoreWindow(_ window: [String: Any]) -> Int {
		var score = 0
		if (window["isFocused"] as? Bool) == true { score += 100 }
		if (window["isMain"] as? Bool) == true { score += 80 }
		if (window["isMinimized"] as? Bool) == false { score += 40 }
		if (window["isOnscreen"] as? Bool) == true { score += 20 }
		if window["windowId"] != nil { score += 10 }
		return score
	}

	private func isModalRoot(_ window: AXUIElement, role: String, subrole: String, sheetCount: Int) -> Bool {
		classifyModal(axModal: boolAttribute(window, attribute: "AXModal" as CFString), sheetCount: sheetCount, role: role, subrole: subrole)
	}

	func rootMetadata(pairing: WindowPairing, sheetCount: Int) -> [String: Any] {
		["pairing": ["confidence": pairing.confidence, "score": pairing.score], "sheetCount": sheetCount]
	}

	private func broadRootCandidateApps(entries: [[String: Any]]) -> [[String: Any]] {
		cgBroadRootOwners(entries: entries).compactMap { owner in
			guard owner.pid != getpid(), pidIsAlive(owner.pid) else { return nil }
			var app: [String: Any] = ["appName": owner.name, "pid": Int(owner.pid)]
			if let bundleId = NSRunningApplication(processIdentifier: owner.pid)?.bundleIdentifier {
				app["bundleId"] = bundleId
			}
			return app
		}
	}

	/// Every listed root is a validated positive match. `complete` is true only when the inventory read every
	/// live root, so a root missing from it closed; a partial listing (e.g. over `windowListCap`) still
	/// resolves the roots it names.
	private func listRoots(pid: Int32?, title: String? = nil) throws -> [String: Any] {
		let inventory = rootInventory(pid: pid, title: title)
		return ["roots": inventory.roots, "complete": inventory.complete]
	}

	/// `unidentified` names (by `rootRef`) the roots whose pairing or identity reads failed (see `windowInventory`).
	private func rootInventory(pid: Int32?, title: String?) -> (roots: [[String: Any]], complete: Bool, unidentified: Set<String>) {
		let requestedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
		let entries = allCGWindowEntries()
		let isBroadDiscovery = pid == nil && requestedTitle.isEmpty
		let apps: [[String: Any]]
		if let pid {
			apps = [["pid": Int(pid)]]
		} else if !requestedTitle.isEmpty {
			let matchingPids = Set(entries.compactMap { entry -> Int32? in
				let candidate = ((entry[kCGWindowName as String] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
				guard candidate == requestedTitle || candidate.contains(requestedTitle) else { return nil }
				return (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
			})
			apps = listApps(cgEntries: entries).filter { app in
				guard let rawPid = app["pid"] as? Int, let pid = Int32(exactly: rawPid) else { return false }
				return matchingPids.contains(pid)
			}
		} else {
			apps = broadRootCandidateApps(entries: entries)
		}
		var roots: [[String: Any]] = []
		var complete = true
		var unidentified = Set<String>()
		for app in apps {
			guard let rawPid = app["pid"] as? Int, let appPid = Int32(exactly: rawPid) else { continue }
			let appName = app["appName"] as? String ?? processName(pid: appPid) ?? "Unknown App"
			let bundleId = app["bundleId"] as? String
			let windows = windowInventory(pid: appPid, cgEntries: entries, messagingTimeout: isBroadDiscovery ? 0.25 : 1.0)
			// An exited process has no roots, however its failed reads look.
			if !windows.complete && !processIsGone(appPid) { complete = false }
			unidentified.formUnion(windows.unidentified)
			for var root in windows.roots {
				root["pid"] = rawPid
				root["appName"] = appName
				if let bundleId { root["bundleId"] = bundleId }
				roots.append(root)
			}
			let popupCandidates = cgPopupMenuCandidates(pid: appPid, entries: entries)
			let menuElements = popupCandidates.isEmpty ? [] : openMenuElements(pid: appPid, messagingTimeout: isBroadDiscovery ? 0.25 : 1.0)
			for (index, candidate) in popupCandidates.enumerated() {
				let menuElement = index < menuElements.count ? menuElements[index] : nil
				let menuRef = menuElement.map { refStore.storeWindow($0) } ?? "cgmenu:\(candidate.windowId)"
				var menu: [String: Any] = [
					"kind": "menu",
					"rootRef": menuRef,
					"windowRef": menuRef,
					"windowId": Int(candidate.windowId),
					"zOrder": candidate.zOrder,
					"title": menuElement.flatMap { stringAttribute($0, attribute: kAXTitleAttribute as CFString) } ?? candidate.title,
					"role": "AXMenu",
					"subrole": "",
					"isModal": false,
					"framePoints": ["x": candidate.bounds.origin.x, "y": candidate.bounds.origin.y, "w": candidate.bounds.width, "h": candidate.bounds.height],
					"scaleFactor": displayScaleFactor(for: candidate.bounds),
					"isMinimized": false,
					"isOnscreen": candidate.isOnscreen,
					"isMain": false,
					"isFocused": true,
					"metadata": ["pairing": ["confidence": menuElement == nil ? "low" : "high", "score": menuElement == nil ? 0 : 100], "sheetCount": 0],
					"pid": rawPid,
					"appName": appName,
				]
				if let bundleId { menu["bundleId"] = bundleId }
				roots.append(menu)
			}
		}
		roots.sort { (($0["zOrder"] as? Int) ?? Int.max) < (($1["zOrder"] as? Int) ?? Int.max) }
		return (roots, complete, unidentified)
	}

	/// An exited process: `kill` reports no such process. Any other answer, including EPERM, may be live.
	private func processIsGone(_ pid: pid_t) -> Bool {
		pid > 0 && kill(pid, 0) != 0 && errno == ESRCH
	}

	private func listWindows(pid: Int32, cgEntries: [[String: Any]]? = nil, messagingTimeout: Float = 1.0) throws -> [[String: Any]] {
		windowInventory(pid: pid, cgEntries: cgEntries, messagingTimeout: messagingTimeout).roots
	}

	/// The pid's windows and sheets (see `RootInventoryWorld.classify`). Not `complete` when the window list, a sheet
	/// source or a skipped window's size could not be read, or the list exceeds `windowListCap`: an omitted root is then
	/// unknown, while every listed root stays a valid positive match. `unidentified` names (by `rootRef`) each root whose
	/// identity `rootIdentity` cannot key the same way in every listing (see `rootIdentityComparable`).
	private func windowInventory(pid: Int32, cgEntries: [[String: Any]]?, messagingTimeout: Float) -> (roots: [[String: Any]], complete: Bool, unidentified: Set<String>) {
		ensureEnhancedAccessibility(pid: pid)
		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, messagingTimeout)
		let world = RootInventoryWorld<AXUIElement>(
			windows: WindowInventoryWorld<AXUIElement>(
				windows: { self.axElementArrayEvidence(appElement, attribute: kAXWindowsAttribute as CFString) },
				fallbackWindows: {
					var windows: [AXUIElement] = []
					for attribute in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
						guard let window = self.copyAttribute(appElement, attribute: attribute as CFString).flatMap(self.asAXElement), !windows.contains(where: { self.sameElement($0, window) }) else { continue }
						windows.append(window)
					}
					return windows
				},
				position: { self.positionRead($0) },
				size: { self.sizeRead($0) },
				sheets: { self.sheetInventory(of: $0) }
			),
			string: { self.stringRead($0, attribute: Bridge.identityAttribute($1)) },
			frame: { self.frameRead($0) },
			pairingRead: { self.pairingRead($0) },
			state: { rootStateBoolean(self.copyAttribute($0, attribute: Bridge.stateAttribute($1))) }
		)
		let inventory = world.classify(candidates: cgWindowCandidates(pid: pid, entries: cgEntries))
		let entries = rootEntries(inventory.windows, ref: { self.refStore.storeWindow($0) }) { classified, sheet in
			let window = classified.window.element
			let pairing = classified.root.pairing
			let candidate = pairing.candidate
			let zIndex = classified.window.listIndex
			guard let sheet else {
				let sheetCount = classified.sheets.count
				return [
					"zOrder": candidate?.zOrder ?? zIndex,
					"isModal": isModalRoot(window, role: classified.root.role.value, subrole: classified.root.subrole.value, sheetCount: sheetCount),
					"scaleFactor": displayScaleFactor(for: classified.root.frame),
					"metadata": rootMetadata(pairing: pairing, sheetCount: sheetCount),
				]
			}
			let sheetCandidate = sheet.pairing.candidate
			return [
				"zOrder": sheetCandidate?.zOrder ?? candidate?.zOrder ?? zIndex,
				"isModal": true,
				"scaleFactor": displayScaleFactor(for: sheet.frame),
				"metadata": ["pairing": ["confidence": sheetCandidate == nil ? pairing.confidence : sheet.pairing.confidence, "score": sheetCandidate == nil ? pairing.score : sheet.pairing.score], "sheetCount": 0],
			]
		}
		return (entries.roots, inventory.complete, entries.unidentified)
	}

	private static func stateAttribute(_ attribute: RootStateAttribute) -> CFString {
		switch attribute {
		case .focused: return kAXFocusedAttribute as CFString
		case .main: return kAXMainAttribute as CFString
		case .minimized: return kAXMinimizedAttribute as CFString
		}
	}

	private static func identityAttribute(_ attribute: RootIdentityAttribute) -> CFString {
		switch attribute {
		case .title: return kAXTitleAttribute as CFString
		case .role: return kAXRoleAttribute as CFString
		case .subrole: return kAXSubroleAttribute as CFString
		}
	}

	private func look(
		_ request: [String: Any], windowOwner: (UInt32) -> Int32?,
		captureWindow: (UInt32) throws -> CapturedWindowImage
	) throws -> [String: Any] {
		// PID first, then window ID: a request with both malformed reports the PID error.
		let suppliedPid = try request["pid"] == nil || request["pid"] is NSNull ? nil : pidArg(request)
		let windowId = try checkedWindowId(request["windowId"])
		let windowRef = optionalStringArg(request, "windowRef")
		let maxDimension = optionalIntArg(request, "maxDimension").map { max(1, $0) }
		let readText = optionalStringArg(request, "readText") ?? "auto"
		let baseLookId = optionalStringArg(request, "baseLookId")
		let includeImage = boolArg(request, "includeImage") ?? true
		let requestDeadline = ProcessInfo.processInfo.systemUptime + lookWalkDeadline
		guard readText == "auto" || readText == "always" || readText == "never" else {
			throw BridgeFailure(message: "readText must be auto, always, or never", code: "invalid_args")
		}

		let requestedRoot = windowRef.flatMap { refStore.window(for: $0) }
		let requestedRole = requestedRoot.flatMap { stringAttribute($0, attribute: kAXRoleAttribute as CFString) } ?? ""
		let isMenuRoot = requestedRole == "AXMenu" || (windowRef?.hasPrefix("cgmenu:") == true)
		let captureStart = Date()
		let shouldCapture = !isMenuRoot && (includeImage || readText == "always")
		if resolveCaptureTarget(windowId: windowId, wantsImage: shouldCapture) == .notCapturable {
			throw BridgeFailure(message: "Root has no capturable window (unpaired with any on-screen window); use semantic observation (mode: semantic)", code: "root_not_capturable")
		}
		let pid: Int32
		if let windowId, let ownerPid = windowOwner(windowId) {
			pid = ownerPid
		} else if !shouldCapture, let requestedRoot, let owner = pidForElement(requestedRoot) {
			pid = owner
		} else {
			throw BridgeFailure(message: "Root is not owned by a running app", code: "root_not_found")
		}
		if let suppliedPid, suppliedPid != pid {
			throw BridgeFailure(message: "pid does not match the resolved root owner", code: "pid_mismatch")
		}
		let capture = try shouldCapture ? windowId.map(captureWindow) : nil
		let captureMs = capture.map { _ in elapsedMs(captureStart) } ?? 0
		ensureEnhancedAccessibility(pid: pid)
		if let windowRef, windowRef.hasPrefix("cgmenu:"), refStore.window(for: windowRef) == nil {
			let frame = windowId.flatMap { windowInfo(windowId: $0)?.bounds } ?? CGRect(x: 0, y: 0, width: 1, height: 1)
			let lookId = freshLookId()
			storeLookRecord(LookRecord(lookId: lookId, windowId: windowId ?? 0, windowFrame: frame, imageWidth: max(1, Int(frame.width)), imageHeight: max(1, Int(frame.height)), hasImage: false))
			let outline = LookNode(element: nil, ref: windowRef, role: "AXMenu", subrole: "", identifier: "", title: "Menu", description: "", value: "", actions: [], canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, rect: CGRect(x: 0, y: 0, width: max(1, frame.width), height: max(1, frame.height)), pictureOnly: true)
			return [
				"lookId": lookId,
				"capturedAt": captureStart.timeIntervalSince1970,
				"window": ["windowId": Int(windowId ?? 0), "rootRef": windowRef, "kind": "menu", "framePoints": ["x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height], "scaleFactor": displayScaleFactor(for: frame), "isModal": false, "metadata": ["pairing": ["confidence": "low", "score": 0], "sheetCount": 0], "role": "AXMenu", "subrole": ""],
				"outline": outline.payload(),
				"timings": ["captureMs": 0, "describeMs": 0, "readTextMs": 0],
			]
		}
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			throw BridgeFailure(message: "Root is not available through Accessibility", code: "root_not_found")
		}
		let rootElement: AXUIElement
		if let scopeRef = optionalStringArg(request, "scopeRef") {
			guard let scoped = refStore.element(for: scopeRef), isElement(scoped, descendantOf: window) else {
				throw BridgeFailure(message: "Scope ref is stale or outside the target root", code: "element_ref_invalid")
			}
			rootElement = scoped
		} else {
			rootElement = window
		}

		let rootFrame = frameForWindow(window)
		let imageWidth: Int
		let imageHeight: Int
		let imagePayload: [String: Any]?
		let transform: (CGRect) -> CGRect
		if let capture {
			let outputImage = downscaledImage(capture.image, maxDimension: maxDimension) ?? capture.image
			imageWidth = outputImage.width
			imageHeight = outputImage.height
			transform = rectTransform(windowFrame: capture.frame, imageWidth: outputImage.width, imageHeight: outputImage.height)
			if includeImage {
				guard let jpeg = jpegData(image: outputImage, quality: 0.8) else {
					throw BridgeFailure(message: "Failed to encode look image as JPEG", code: "encoding_failed")
				}
				imagePayload = ["jpegBase64": jpeg.base64EncodedString(), "width": outputImage.width, "height": outputImage.height]
			} else {
				imagePayload = nil
			}
		} else {
			imageWidth = max(1, Int(rootFrame.width))
			imageHeight = max(1, Int(rootFrame.height))
			imagePayload = nil
			transform = rectTransform(windowFrame: rootFrame, imageWidth: imageWidth, imageHeight: imageHeight)
		}
		// Mint the look id first: it owns every element ref the tree build creates. If the look is never
		// recorded (an error below), drop those refs instead of leaking them.
		let lookId = freshLookId()
		var lookStored = false
		defer { if !lookStored { refStore.dropElements(owner: lookId) } }
		let describeStart = Date()
		let outline = buildLookOutline(root: rootElement, owner: lookId, transform: transform, requestDeadline: requestDeadline)
		let describeMs = elapsedMs(describeStart)

		var readTextMs = 0
		var readTextExecuted = false
		if let capture, readText == "always" {
			readTextExecuted = true
			let textStart = Date()
			let boxes = try recognizeText(in: capture.image, outputWidth: imageWidth, outputHeight: imageHeight)
			attachOCR(boxes, to: outline)
			readTextMs = elapsedMs(textStart)
		}

		let baseRecord = baseLookId.flatMap { lookRecord(for: $0) }
		if let baseLookId, baseRecord != nil { refStore.transferElements(from: baseLookId, to: lookId) }
		lookStored = true
		storeLookRecord(LookRecord(
			lookId: lookId,
			windowId: windowId ?? baseRecord?.windowId ?? 0,
			windowRef: windowRef ?? baseRecord?.windowRef,
			windowFrame: baseRecord?.windowFrame ?? capture?.frame ?? rootFrame,
			imageWidth: baseRecord?.imageWidth ?? imageWidth,
			imageHeight: baseRecord?.imageHeight ?? imageHeight,
			hasImage: baseRecord?.hasImage ?? (capture != nil)
		))
		let scale = (capture?.frame.width ?? rootFrame.width) > 0 ? Double(imageWidth) / (capture?.frame.width ?? rootFrame.width) : displayScaleFactor(for: rootFrame)
		let pairing = pairingForWindow(window, pid: pid)
		let role = stringAttribute(window, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(window, attribute: kAXSubroleAttribute as CFString) ?? ""
		let sheetCount = sheetElements(of: window).count
		var response: [String: Any] = [
			"lookId": lookId,
			"capturedAt": captureStart.timeIntervalSince1970,
			"window": [
				"windowId": Int(windowId ?? 0),
				"rootRef": windowRef ?? refStore.storeWindow(window),
				"kind": rootKind(role: role, subrole: subrole),
				"framePoints": ["x": (capture?.frame ?? rootFrame).origin.x, "y": (capture?.frame ?? rootFrame).origin.y, "w": (capture?.frame ?? rootFrame).width, "h": (capture?.frame ?? rootFrame).height],
				"scaleFactor": scale,
				"isModal": isModalRoot(window, role: role, subrole: subrole, sheetCount: sheetCount),
				"metadata": rootMetadata(pairing: pairing, sheetCount: sheetCount),
				"role": role,
				"subrole": subrole,
			],
			"outline": outline.payload(),
			"timings": ["captureMs": captureMs, "describeMs": describeMs, "readTextMs": readTextMs],
			"readText": ["requested": readText, "executed": readTextExecuted],
		]
		if let imagePayload { response["image"] = imagePayload }
		return response
	}

	private func elapsedMs(_ start: Date) -> Int {
		max(0, Int(Date().timeIntervalSince(start) * 1000.0))
	}

	private func storeLookRecord(_ record: LookRecord) {
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		lookRecords[record.lookId] = record
		lookRecordOrder.append(record.lookId)
		while lookRecordOrder.count > 8 {
			let oldest = lookRecordOrder.removeFirst()
			lookRecords.removeValue(forKey: oldest)
			refStore.dropElements(owner: oldest)
		}
	}

	private func freshLookId() -> String {
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		nextLookId += 1
		return "look_\(nextLookId)"
	}

	func lookRecord(for lookId: String) -> LookRecord? {
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		return lookRecords[lookId]
	}

	func rectTransform(windowFrame: CGRect, imageWidth: Int, imageHeight: Int) -> (CGRect) -> CGRect {
		let sx = windowFrame.width > 0 ? Double(imageWidth) / windowFrame.width : 1.0
		let sy = windowFrame.height > 0 ? Double(imageHeight) / windowFrame.height : 1.0
		return { frame in
			let x = (frame.origin.x - windowFrame.origin.x) * sx
			let y = (frame.origin.y - windowFrame.origin.y) * sy
			let w = frame.width * sx
			let h = frame.height * sy
			return self.clampRect(CGRect(x: x, y: y, width: w, height: h), width: imageWidth, height: imageHeight)
		}
	}

	func clampRect(_ rect: CGRect, width: Int, height: Int) -> CGRect {
		let maxX = Double(width)
		let maxY = Double(height)
		let x1 = min(max(rect.minX, 0), maxX)
		let y1 = min(max(rect.minY, 0), maxY)
		let x2 = min(max(rect.maxX, 0), maxX)
		let y2 = min(max(rect.maxY, 0), maxY)
		return CGRect(x: x1, y: y1, width: max(0, x2 - x1), height: max(0, y2 - y1))
	}

	/// The look's outline (see `LookOutlineWorld.build`): a failed children read marks the node `truncated`.
	/// - Parameter requestDeadline: The look's `lookWalkDeadline`, on the `systemUptime` clock.
	private func buildLookOutline(root: AXUIElement, owner: String, transform: @escaping (CGRect) -> CGRect, requestDeadline: TimeInterval) -> LookNode {
		let world = LookOutlineWorld<AXUIElement>(
			children: { self.axElementArrayEvidence($0, attribute: kAXChildrenAttribute as CFString) },
			rootNode: { self.lookNode(element: $0, transform: transform, offscreen: false, owner: owner) },
			childNodes: { parent in
				let visibleByKind = self.visibleChildrenByKind(parent)
				return { child in
					let role = self.stringAttribute(child, attribute: kAXRoleAttribute as CFString) ?? ""
					let offscreen = self.childOffscreen(child, role: role, visibleByKind: visibleByKind)
					return self.lookNode(element: child, transform: transform, offscreen: offscreen, owner: owner)
				}
			},
			now: { ProcessInfo.processInfo.systemUptime }
		)
		// Apps with slow AX servers (e.g. Outlook) can take >30s to describe; the
		// client aborts at 33s, so stop walking well before that and return a
		// truncated outline instead.
		return world.build(root: root, nodeLimit: 2000, timeLimit: 20.0, requestDeadline: requestDeadline)
	}

	/// `owner` is the look whose lifetime bounds the element ref; nil for one-off element queries.
	private func lookNode(element: AXUIElement, transform: (CGRect) -> CGRect, offscreen: Bool, owner: String? = nil) -> LookNode {
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		let actions = actionNames(element)
		var valueSettable = DarwinBoolean(false)
		let valueStatus = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &valueSettable)
		var focusedSettable = DarwinBoolean(false)
		let focusedStatus = AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &focusedSettable)
		let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXTextView", "AXSearchField", "AXComboBox", "AXEditableText", "AXSecureTextField"]
		let title = stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? ""
		let description = stringAttribute(element, attribute: kAXDescriptionAttribute as CFString) ?? ""
		let value = displayValue(element, role: role, subrole: subrole)
		let screenRect = frameForElement(element) ?? .zero
		let node = LookNode(
			element: element,
			ref: refStore.storeElement(element, snapshot: AXRefStore.Snapshot(
				role: role,
				identifier: stringAttribute(element, attribute: "AXIdentifier" as CFString) ?? "",
				label: normalizedLabel([title, description, value].joined(separator: " ")),
				rect: screenRect
			), owner: owner),
			role: role,
			subrole: subrole,
			identifier: stringAttribute(element, attribute: "AXIdentifier" as CFString) ?? "",
			title: title,
			description: description,
			value: value,
			actions: actions,
			canPress: actions.contains(kAXPressAction as String),
			canFocus: focusedStatus == .success && focusedSettable.boolValue,
			canSetValue: valueStatus == .success && valueSettable.boolValue,
			canScroll: supportsAnyScrollAction(element),
			canIncrement: actions.contains(kAXIncrementAction as String),
			canDecrement: actions.contains(kAXDecrementAction as String),
			isTextInput: textRoles.contains(role),
			rect: transform(screenRect),
			focused: boolAttribute(element, attribute: kAXFocusedAttribute as CFString) == true,
			offscreen: offscreen
		)
		if node.canScroll {
			let rows = axElementArray(element, attribute: kAXRowsAttribute as CFString)
			let visibleRows = axElementArrayIfPresent(element, attribute: kAXVisibleRowsAttribute as CFString)
			if !rows.isEmpty, let visibleRows {
				node.scrollExtent = ["seen": visibleRows.count, "total": rows.count]
			}
		}
		return node
	}

	private func visibleChildrenByKind(_ element: AXUIElement) -> [String: [AXUIElement]?] {
		[
			"AXRow": axElementArrayIfPresent(element, attribute: kAXVisibleRowsAttribute as CFString),
			"AXColumn": axElementArrayIfPresent(element, attribute: kAXVisibleColumnsAttribute as CFString),
			"AXCell": axElementArrayIfPresent(element, attribute: kAXVisibleCellsAttribute as CFString),
			"*": axElementArrayIfPresent(element, attribute: kAXVisibleChildrenAttribute as CFString),
		]
	}

	private func childOffscreen(_ child: AXUIElement, role: String, visibleByKind: [String: [AXUIElement]?]) -> Bool {
		let key = role == "AXRow" || role == "AXColumn" || role == "AXCell" ? role : "*"
		guard let visible = visibleByKind[key] ?? nil else { return false }
		return !visible.contains { sameElement($0, child) }
	}

	private func recognizeText(in image: CGImage, outputWidth: Int, outputHeight: Int) throws -> [OCRBox] {
		let semaphore = DispatchSemaphore(value: 0)
		let recognized = Box<[OCRBox]>([])
		let recognizedError = Box<Error?>(nil)
		let request = VNRecognizeTextRequest { request, error in
			defer { semaphore.signal() }
			if let error {
				recognizedError.value = error
				return
			}
			let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
			recognized.value = observations.compactMap { observation in
				guard let candidate = observation.topCandidates(1).first else { return nil }
				let box = observation.boundingBox
				let x = box.origin.x * Double(outputWidth)
				let y = (1.0 - box.origin.y - box.height) * Double(outputHeight)
				let w = box.width * Double(outputWidth)
				let h = box.height * Double(outputHeight)
				return OCRBox(string: candidate.string, confidence: Double(candidate.confidence), rect: CGRect(x: x, y: y, width: w, height: h))
			}
		}
		request.recognitionLevel = .accurate
		request.usesLanguageCorrection = false
		try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
		if semaphore.wait(timeout: .now() + .seconds(8)) == .timedOut {
			throw BridgeFailure(message: "Text recognition timed out", code: "text_recognition_timeout")
		}
		if let error = recognizedError.value {
			throw BridgeFailure(message: "Text recognition failed: \(error.localizedDescription)", code: "text_recognition_failed")
		}
		return recognized.value
	}

	func attachOCR(_ boxes: [OCRBox], to root: LookNode) {
		var pictureOnlyIndex = 0
		for box in boxes {
			if ocrBoxDuplicatesAXLabel(box, in: root) { continue }
			let center = CGPoint(x: box.rect.midX, y: box.rect.midY)
			if let node = deepestNode(containing: center, in: root) {
				node.text.append(["string": box.string, "confidence": box.confidence, "rect": ["x": box.rect.origin.x, "y": box.rect.origin.y, "w": box.rect.width, "h": box.rect.height]])
			} else {
				pictureOnlyIndex += 1
				let parent = deepestContainer(containing: center, in: root) ?? root
				parent.children.append(LookNode(element: nil, ref: "pic_\(pictureOnlyIndex)", role: "AXImage", subrole: "", identifier: "", title: box.string, description: "", value: "", actions: [], canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, rect: box.rect, pictureOnly: true))
			}
		}
	}

	private func ocrBoxDuplicatesAXLabel(_ box: OCRBox, in root: LookNode) -> Bool {
		let boxLabel = normalizedLabel(box.string)
		if boxLabel.isEmpty { return true }
		var queue = [root]
		var index = 0
		while index < queue.count {
			let node = queue[index]
			index += 1
			if !node.pictureOnly, node.rect.intersects(box.rect) {
				let fields = [node.title, node.value, node.description]
				if fields.contains(where: { normalizedLabel($0) == boxLabel }) { return true }
			}
			queue.append(contentsOf: node.children)
		}
		return false
	}

	private func deepestNode(containing point: CGPoint, in root: LookNode) -> LookNode? {
		guard root.rect.contains(point), !root.pictureOnly else { return nil }
		for child in root.children.reversed() {
			if let match = deepestNode(containing: point, in: child) { return match }
		}
		return root
	}

	private func deepestContainer(containing point: CGPoint, in root: LookNode) -> LookNode? {
		guard root.rect.contains(point) else { return nil }
		for child in root.children.reversed() {
			if let match = deepestContainer(containing: point, in: child) { return match }
		}
		return root
	}

	private func lookPoint(record: LookRecord, x: Double, y: Double) -> CGPoint {
		let relX = min(max(x / max(1.0, Double(record.imageWidth)), 0), 1)
		let relY = min(max(y / max(1.0, Double(record.imageHeight)), 0), 1)
		return CGPoint(x: record.windowFrame.origin.x + record.windowFrame.width * relX, y: record.windowFrame.origin.y + record.windowFrame.height * relY)
	}

	/// The grounded point of an x/y act target. A ref target wins over x/y and returns nil: act grounds it
	/// on the live element only when it runs.
	private func coordinateTargetPoint(_ target: [String: Any], record: LookRecord) -> CGPoint? {
		guard target["ref"] as? String == nil, let x = target["x"] as? NSNumber, let y = target["y"] as? NSNumber else { return nil }
		return lookPoint(record: record, x: x.doubleValue, y: y.doubleValue)
	}

	/// The drag geometry admission shared by `act` and `actBatch`: the action point and every grounded
	/// vertex pass the same checks as the native sink, before any lock, focus, preflight or allocation.
	private func admittedDragPoints(at point: CGPoint?, params: [String: Any], record: LookRecord) throws -> [CGPoint] {
		if let point { try validateDragPoint(point) }
		let points = try dragRequestPoints(params["path"]).map { lookPoint(record: record, x: $0.x, y: $0.y) }
		_ = try admittedDragStep(points)
		return points
	}

	private func payloadNode(element: AXUIElement) -> [String: Any] {
		let node = lookNode(element: element, transform: { $0 }, offscreen: false)
		var payload = node.payload()
		payload["children"] = []
		return payload
	}

	func normalizedLabel(_ value: String) -> String {
		value.lowercased().components(separatedBy: CharacterSet.whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
	}

	private func ensureRootObserver(pid: Int32) -> Bool {
		rootObserverLock.lock()
		if let existing = rootObservers[pid] {
			existing.lastUsed = Date().timeIntervalSince1970
			rootObserverLock.unlock()
			return true
		}
		rootObserverLock.unlock()

		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 0.25)
		var observer: AXObserver?
		let createStatus = AXObserverCreate(pid, { observer, element, notification, refcon in
			guard let refcon else { return }
			let bridge = Unmanaged<Bridge>.fromOpaque(refcon).takeUnretainedValue()
			bridge.recordRootAXEvent(observer: observer, notification: notification as String, element: element)
		}, &observer)
		guard createStatus == .success, let observer else { return false }

		let state = RootAXObserverState(pid: pid, observer: observer)
		let context = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
		let notifications: [CFString] = [
			"AXWindowCreated" as CFString,
			"AXSheetCreated" as CFString,
			"AXMenuOpened" as CFString,
			"AXMenuClosed" as CFString,
			"AXUIElementDestroyed" as CFString,
			"AXFocusedWindowChanged" as CFString,
			kAXValueChangedNotification as CFString,
			kAXTitleChangedNotification as CFString,
			kAXSelectedChildrenChangedNotification as CFString,
			kAXLayoutChangedNotification as CFString,
		]
		var registered = false
		let observedElements = [appElement] + axElementArray(appElement, attribute: kAXWindowsAttribute as CFString)
		for observed in observedElements {
			for notification in notifications {
				let status = AXObserverAddNotification(observer, observed, notification, context)
				if status == .success || status == .notificationAlreadyRegistered { registered = true }
			}
		}
		guard registered else { return false }

		installRootObserver(state)

		let source = AXObserverGetRunLoopSource(observer)
		Thread.detachNewThread {
			// Keep each AXObserver on its own run loop so its callbacks never compete
			// with AppKit rendering on the helper's main thread.
			CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
			CFRunLoopRun()
		}
		return true
	}

	/// Register `state` under the observer lock, evicting the least recently used root at the cap.
	func installRootObserver(_ state: RootAXObserverState) {
		rootObserverLock.lock()
		if rootObservers.count >= maxRootObservers,
			let evict = rootObservers.values.min(by: { $0.lastUsed < $1.lastUsed })?.pid
		{
			rootObservers.removeValue(forKey: evict)
		}
		rootObservers[state.pid] = state
		rootObserverLock.unlock()
	}

	func recordRootAXEvent(observer: CFTypeRef, notification: String, element: AXUIElement) {
		rootObserverLock.lock()
		let state = rootObservers.values.first { CFEqual($0.observer, observer) }
		if let state {
			state.events.append(RootAXEvent(sequence: state.nextSequence, timestamp: Date().timeIntervalSince1970, notification: notification, element: element))
			state.nextSequence += 1
			if state.events.count > 64 { state.events.removeFirst(state.events.count - 64) }
		}
		rootObserverLock.unlock()
		if let state {
			state.change.lock()
			state.changeGeneration += 1
			state.change.broadcast()
			state.change.unlock()
		}
	}

	func rootChangeGeneration(pid: Int32) -> UInt64 {
		rootObserverLock.lock()
		let state = rootObservers[pid]
		rootObserverLock.unlock()
		guard let state else { return 0 }
		state.change.lock()
		defer { state.change.unlock() }
		return state.changeGeneration
	}

	/// Block until `pid`'s change generation moves past `generation`, for at most 200 ms and never past
	/// `deadline`. An unobserved pid sleeps the same bound instead.
	func waitForRootChange(pid: Int32, since generation: UInt64, until deadline: Date, waiter: RootChangeWaiter = .live) {
		rootObserverLock.lock()
		let state = rootObservers[pid]
		rootObserverLock.unlock()
		guard let state else {
			waiter.sleep(min(0.2, max(0, deadline.timeIntervalSince(waiter.now()))))
			return
		}
		state.change.lock()
		if state.changeGeneration == generation {
			waiter.wait(state.change, min(deadline, waiter.now().addingTimeInterval(0.2)))
		}
		state.change.unlock()
	}

	func rootEventCursor(pid: Int32) -> UInt64 {
		rootObserverLock.lock()
		defer { rootObserverLock.unlock() }
		return rootObservers[pid]?.nextSequence ?? 1
	}

	func rootEvents(pid: Int32, since cursor: UInt64) -> [RootAXEvent] {
		rootObserverLock.lock()
		defer { rootObserverLock.unlock() }
		guard let events = rootObservers[pid]?.events else { return [] }
		return events.filter { $0.sequence >= cursor }
	}

	// Onscreen CGWindowList id set for one pid: ~1-2ms per call, so it can be
	// polled tightly where a full AX enumeration cannot.
	private func cgRootSignature(pid: Int32) -> Set<UInt32> {
		guard let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
		var ids = Set<UInt32>()
		for entry in entries {
			guard let owner = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, owner == pid else { continue }
			guard let windowId = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { continue }
			ids.insert(windowId)
		}
		return ids
	}

	private func refindElement(ref: String, pid: Int32, windowId: UInt32?, windowRef: String? = nil) -> AXUIElement? {
		guard let snapshot = refStore.snapshot(for: ref),
			let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef)
		else { return nil }
		let targetCenter = CGPoint(x: snapshot.rect.midX, y: snapshot.rect.midY)
		let candidates = collectDescendants(startingAt: window, maxDepth: 8).filter { candidate in
			let role = stringAttribute(candidate, attribute: kAXRoleAttribute as CFString) ?? ""
			guard role == snapshot.role else { return false }
			let identifier = stringAttribute(candidate, attribute: "AXIdentifier" as CFString) ?? ""
			if !snapshot.identifier.isEmpty { return identifier == snapshot.identifier }
			let subrole = stringAttribute(candidate, attribute: kAXSubroleAttribute as CFString) ?? ""
			let title = stringAttribute(candidate, attribute: kAXTitleAttribute as CFString) ?? ""
			let description = stringAttribute(candidate, attribute: kAXDescriptionAttribute as CFString) ?? ""
			let value = displayValue(candidate, role: role, subrole: subrole)
			return normalizedLabel([title, description, value].joined(separator: " ")) == snapshot.label
		}
		return candidates.min { left, right in
			let leftFrame = frameForElement(left) ?? .zero
			let rightFrame = frameForElement(right) ?? .zero
			let leftDistance = hypot(leftFrame.midX - targetCenter.x, leftFrame.midY - targetCenter.y)
			let rightDistance = hypot(rightFrame.midX - targetCenter.x, rightFrame.midY - targetCenter.y)
			return leftDistance < rightDistance
		}
	}

	private func hitTest(_ request: [String: Any]) throws -> [String: Any] {
		let lookId = try stringArg(request, "lookId")
		guard let record = lookRecord(for: lookId) else {
			throw BridgeFailure(message: "Look id '\(lookId)' is no longer available", code: "stale_look")
		}
		let point = lookPoint(record: record, x: try doubleArg(request, "x"), y: try doubleArg(request, "y"))
		guard let element = hitTestElement(at: point) else {
			throw BridgeFailure(message: "No element at point", code: "hit_test_failed")
		}
		return payloadNode(element: element)
	}

	func actionWorld() -> ActWorld {
		let scroll = scrollWorld()
		return ActWorld(
			lookRecord: lookRecord(for:), cachedElement: refStore.element(for:), refindElement: refindElement(ref:pid:windowId:windowRef:),
			copyAttribute: copyAttribute(_:attribute:), stringAttribute: stringAttribute(_:attribute:), frame: frameForElement,
			hasAncestorRole: hasAncestorRole(_:role:), supportsAction: supportsAction(_:action:),
			performAction: AXUIElementPerformAction, setAttribute: AXUIElementSetAttributeValue,
			hitTest: { self.hitTestElement(at: $0) }, sameElement: sameElement, isDescendant: isElement(_:descendantOf:),
			describeElement: { "\(self.payloadNode(element: $0))" },
			sheetCount: { pid, record in
				self.windowElement(pid: pid, windowId: record.windowId > 0 ? record.windowId : nil, windowRef: record.windowRef).map { self.sheetElements(of: $0).count }
			},
			focusedWindow: focusedWindowSummary(pid:),
			activateIfInactive: { pid in
				guard let app = NSRunningApplication(processIdentifier: pid), !app.isActive else { return nil }
				return app.activate()
			},
			raiseWindow: { pid, record in
				guard let window = self.windowElement(pid: pid, windowId: record.windowId > 0 ? record.windowId : nil, windowRef: record.windowRef) else { return nil }
				_ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
				_ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
				return AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success
			},
			animateCursor: { point, windowId in Task { @MainActor in AgentCursor.shared.animate(to: point, above: windowId) } },
			requireTargetFocus: requireTargetFocus(pid:), keyboardAdmission: keyboardAdmission(blocked:deadline:),
			refuseBlockedPoints: refuseBlockedPoints(_:blocked:), beginRootDelta: beginActRootDelta(pid:),
			lockInput: physicalInputLock.lock, unlockInput: physicalInputLock.unlock, sleep: { _ = usleep($0) },
			scrollSignature: scrollPositionSignature,
			scrollAction: { self.performScrollActionOrAncestor(startingAt: $0, request: $1, world: scroll) },
			scrollBar: { self.setScrollBarValueOrAncestor(startingAt: $0, request: $1, world: scroll) },
			postMouseClick: postMouseClick(at:pid:button:clickCount:delivery:), postMouseMove: postMouseMove(to:pid:delivery:),
			postScrollWheel: postScrollWheel(at:deltaX:deltaY:pid:delivery:), postMouseDrag: postMouseDrag(points:pid:delivery:),
			postKeyPress: postKeyPress(keys:pid:delivery:beforeKeyDown:),
			postKeyCode: { try self.postKeyCode($0, flags: $1, pid: $2, delivery: $3, beforeKeyDown: $4) },
			postUnicodeText: postUnicodeText(_:pid:delivery:beforeKeyDown:),
			postAtomicUnicodeText: postAtomicUnicodeText(_:pid:delivery:beforeKeyDown:),
			snapshotClipboard: snapshotClipboard, pasteKeyCode: { pasteKeyCode(layoutData: currentKeyboardInputSource().layoutData) }
		)
	}

	private func beginActRootDelta(pid: Int32) -> ([String: Any]) -> [String: Any] {
		let eventsLive = ensureRootObserver(pid: pid)
		let eventCursor = eventsLive ? rootEventCursor(pid: pid) : 0
		let beforeRootSnapshot = rootMetadataSnapshot(pid: pid)
		let beforeCgSignature = cgRootSignature(pid: pid)
		let beforeFrontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
		return { response in
			self.attachRootDelta(to: response, before: beforeRootSnapshot, beforeFrontmostPid: beforeFrontmostPid, pid: pid, eventsLive: eventsLive, eventCursor: eventCursor, beforeCgSignature: beforeCgSignature)
		}
	}

	private func act(_ request: [String: Any]) throws -> [String: Any] {
		try act(request, world: actionWorld(), supportsAgentCursor: supportsAgentCursor)
	}

	func act(_ request: [String: Any], world: ActWorld, supportsAgentCursor: Bool) throws -> [String: Any] {
		let pid = try pidArg(request)
		let deadline = keyboardDeadline(request, now: ProcessInfo.processInfo.systemUptime, ceiling: nil)
		let lookId = try stringArg(request, "lookId")
		guard let record = world.lookRecord(lookId) else {
			throw BridgeFailure(message: "Look id '\(lookId)' is no longer available", code: "stale_look")
		}
		let action = try stringArg(request, "action")
		let target = request["target"] as? [String: Any] ?? [:]
		let params = request["params"] as? [String: Any] ?? [:]
		let policy = optionalStringArg(request, "policy") ?? "default"
		let deferRootDelta = boolArg(request, "deferRootDelta") ?? false
		let delivery = policy == "background" ? "pid" : ((params["delivery"] as? String) == "pid" ? "pid" : "hid")
		var holdsPhysicalInput = false
		func acquirePhysicalInputIfNeeded() {
			if delivery == "hid" && !holdsPhysicalInput {
				world.lockInput()
				holdsPhysicalInput = true
			}
		}
		defer { if holdsPhysicalInput { world.unlockInput() } }
		func rejectInStrictHeadless(_ message: String) throws {
			if policy == "ax_only" { throw BridgeFailure(message: message, code: "foreground_required") }
		}
		var performed: [String: Any] = ["delivery": delivery]
		// Wheel deltas left after a partial scroll bar write; nil delivers the requested scroll unchanged.
		var wheelDeltaOverride: (x: Int, y: Int)?
		var scrollWriteUnconfirmed = false
		var element: AXUIElement?
		var rawPoint: CGPoint?
		var preflightCapsUnknown = false
		let rootDelta = deferRootDelta ? nil : world.beginRootDelta(pid)
		let beforeSheetCount = world.sheetCount(pid, record) ?? 0
		let beforeFocusedWindow = world.focusedWindow(pid)
		let beforeValue: String?
		let beforeSelected: String?
		func finish(_ response: [String: Any]) -> [String: Any] {
			return rootDelta?(response) ?? response
		}

		if let ref = target["ref"] as? String {
			var refound = false
			let cached = world.cachedElement(ref)
			let cachedIsLive = cached.map {
				world.stringAttribute($0, kAXRoleAttribute as CFString) != nil && world.frame($0) != nil
			} ?? false
			let resolved: AXUIElement?
			if cachedIsLive {
				resolved = cached
			} else {
				refound = true
				resolved = world.refindElement(ref, pid, record.windowId > 0 ? record.windowId : nil, record.windowRef)
			}
			guard let stored = resolved else {
				throw BridgeFailure(message: "Element reference is stale", code: "stale_ref")
			}
			if refound { performed["refound"] = true }
			element = stored
			beforeValue = world.stringAttribute(stored, kAXValueAttribute as CFString)
			beforeSelected = world.stringAttribute(stored, kAXSelectedTextAttribute as CFString)
		} else if let point = coordinateTargetPoint(target, record: record) {
			guard record.hasImage else {
				throw BridgeFailure(message: "Coordinate targeting is unavailable for this outline-only root", code: "coordinate_unavailable_for_root")
			}
			rawPoint = point
			beforeValue = nil
			beforeSelected = nil
		} else {
			throw BridgeFailure(message: "act target must include ref or x/y", code: "invalid_args")
		}

		func coordinatePoint() throws -> CGPoint {
			if let element, let frame = world.frame(element) {
				return CGPoint(x: frame.midX, y: frame.midY)
			}
			if let rawPoint { return rawPoint }
			throw BridgeFailure(message: "No coordinate grounding is available", code: "coordinate_unavailable")
		}

		func animateCursor(at point: CGPoint) {
			guard supportsAgentCursor,
				(request["cursorOverlay"] as? Bool ?? true),
				delivery == "pid",
				policy != "ax_only",
				["press", "click", "moveMouse", "scroll", "drag"].contains(action)
			else { return }
			world.animateCursor(point, record.windowId)
		}

		func focusTargetForPhysicalInput() {
			guard delivery == "hid" else { return }
			if let activated = world.activateIfInactive(pid) { performed["activated"] = activated }
			if let raised = world.raiseWindow(pid, record) { performed["raised"] = raised }
			world.sleep(20_000)
		}

		func preflight(_ point: CGPoint) throws {
			guard let element else { preflightCapsUnknown = true; return }
			for attempt in 0..<4 {
				guard let hit = world.hitTest(point) else { preflightCapsUnknown = true; return }
				if world.sameElement(hit, element) || world.isDescendant(hit, element) || world.isDescendant(element, hit) { return }
				let role = world.stringAttribute(hit, kAXRoleAttribute as CFString) ?? ""
				if role == "AXWindow" || role == "AXApplication" { preflightCapsUnknown = true; return }
				if delivery == "hid" && attempt < 3 {
					focusTargetForPhysicalInput()
					world.sleep(20_000)
					continue
				}
				throw BridgeFailure(message: "Target is occluded by \(world.describeElement(hit))", code: "occluded_target")
			}
		}

		/// HID events land on whatever is at the point, which can be a blocked app's floating window. Runs after
		/// focus and preflight, right before posting; pid delivery skips it (the target root is checked in TypeScript).
		func refuseBlockedBeforePost(_ points: [CGPoint]) throws {
			guard actPointerRefusalApplies(delivery: delivery) else { return }
			try world.refuseBlockedPoints(points, blockedBundleIdList(request))
		}

		let keyboard = KeyboardPostCounter(world.keyboardAdmission(delivery == "hid" ? blockedBundleIdList(request) : nil, deadline))
		let admitKeyboard = keyboard.beforeKeyDown
		func recheckBlockedKeyboard() throws {
			try admitKeyboard(true, false)
		}

		/// HID keys reach the focused app: settle focus on the target first, then refuse a blocked focused app.
		func refuseBlockedKeyboardAfterFocus(preserveFocus: Bool) throws {
			guard delivery == "hid" else { return }
			if !preserveFocus {
				focusTargetForPhysicalInput()
				try world.requireTargetFocus(pid)
			}
			try recheckBlockedKeyboard()
		}

		func executeCoordinates(_ point: CGPoint) throws {
			try rejectInStrictHeadless("Action requires synthesized pointer input, which strict headless mode prohibits")
			guard element != nil || record.hasImage else {
				throw BridgeFailure(message: "Coordinate grounding is unavailable for this outline-only root", code: "coordinate_unavailable_for_root")
			}
			performed["grounding"] = "coordinates"
			if delivery == "pid" { performed["verification"] = "caller_required" }
			let dragPoints: [CGPoint]
			if action == "drag" {
				dragPoints = try admittedDragPoints(at: point, params: params, record: record)
			} else {
				dragPoints = []
			}
			acquirePhysicalInputIfNeeded()
			focusTargetForPhysicalInput()
			if delivery == "hid" { try preflight(point) }
			switch action {
			case "press", "click":
				animateCursor(at: point)
				try refuseBlockedBeforePost([point])
				try world.postMouseClick(point, pid, mouseButton(params["button"] as? String ?? "left"), max(1, min(3, (params["clickCount"] as? NSNumber)?.intValue ?? 1)), delivery)
			case "moveMouse":
				animateCursor(at: point)
				try refuseBlockedBeforePost([point])
				try world.postMouseMove(point, pid, delivery)
			case "scroll":
				animateCursor(at: point)
				try refuseBlockedBeforePost([point])
				try world.postScrollWheel(point, wheelDeltaOverride?.x ?? (params["scrollX"] as? NSNumber)?.intValue ?? 0, wheelDeltaOverride?.y ?? (params["scrollY"] as? NSNumber)?.intValue ?? 0, pid, delivery)
			case "drag":
				animateCursor(at: point)
				try refuseBlockedBeforePost(dragPoints)
				try world.postMouseDrag(dragPoints, pid, delivery)
			default:
				throw BridgeFailure(message: "Action \(action) cannot use coordinate grounding", code: "invalid_args")
			}
		}

		func refreshElement() -> AXUIElement? {
			guard let ref = target["ref"] as? String,
				let refreshed = world.refindElement(ref, pid, record.windowId > 0 ? record.windowId : nil, record.windowRef)
			else { return nil }
			element = refreshed
			performed["refound"] = true
			return refreshed
		}

		if element == nil, action == "secondaryAction" || action == "selectText" {
			throw BridgeFailure(message: "\(action) requires a ref", code: "invalid_args")
		}

		if let element, action == "press" || action == "click" {
			let elementRole = world.stringAttribute(element, kAXRoleAttribute as CFString) ?? ""
			let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXTextView", "AXSearchField", "AXComboBox", "AXEditableText", "AXSecureTextField"]
			let requiresPointerFocus = world.hasAncestorRole(element, "AXWebArea") || textRoles.contains(elementRole)
			if requiresPointerFocus && policy != "ax_only" {
				if policy == "foreground" {
					try executeCoordinates(coordinatePoint())
				} else {
					throw BridgeFailure(message: "Web content requires pointer input", code: "foreground_required")
				}
			} else if world.supportsAction(element, kAXPressAction as CFString) {
				let cursorPoint = try? coordinatePoint()
				var status = world.performAction(element, kAXPressAction as CFString)
				if status != .success, axPressNotDelivered(axError: status.rawValue), let refreshed = refreshElement(), world.supportsAction(refreshed, kAXPressAction as CFString) {
					status = world.performAction(refreshed, kAXPressAction as CFString)
				}
				if status == .success {
					performed["grounding"] = "description"
					performed["delivery"] = "ax"
					if let cursorPoint { animateCursor(at: cursorPoint) }
				} else if axPressNotDelivered(axError: status.rawValue) {
					try executeCoordinates(coordinatePoint())
				} else {
					// The press may have landed: report it unknown instead of pressing or clicking again.
					performed["grounding"] = "description"
					performed["delivery"] = "ax"
					return finish(["outcome": "unknown", "performed": performed, "evidence": ["deliveryUnknown": true],
						"error": ["code": "ax_delivery_unknown", "message": "AXPress failed (AXError \(status.rawValue)) and may have been delivered; it was not retried"]])
				}
			} else {
				try executeCoordinates(coordinatePoint())
			}
		} else if let element, action == "setText" {
			let text = params["text"] as? String ?? ""
			if world.hasAncestorRole(element, "AXWebArea") {
				try rejectInStrictHeadless("Web text replacement requires synthesized keyboard input, which strict headless mode prohibits")
				acquirePhysicalInputIfNeeded()
				// HID keys follow (cmd+a, text): the same focus wait and blocked-app check as typeText/keypress.
				if delivery == "hid" { try refuseBlockedKeyboardAfterFocus(preserveFocus: false) } else { focusTargetForPhysicalInput() }
				_ = world.setAttribute(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
				try recheckBlockedKeyboard()
				let currentValue = world.stringAttribute(element, kAXValueAttribute as CFString) ?? ""
				try recheckBlockedKeyboard()
				var range = CFRange(location: 0, length: (currentValue as NSString).length)
				let selected = AXValueCreate(.cfRange, &range).map {
					world.setAttribute(element, kAXSelectedTextRangeAttribute as CFString, $0) == .success
				} ?? false
				if !selected {
					try recheckBlockedKeyboard()
					try keyboard.deliver { try world.postKeyPress(["cmd", "a"], pid, delivery, admitKeyboard) }
					world.sleep(20_000)
				}
				try recheckBlockedKeyboard()
				try keyboard.deliver { try world.postAtomicUnicodeText(text, pid, delivery, admitKeyboard) }
				world.sleep(40_000)
				let verificationElement = refreshElement() ?? element
				let value = world.stringAttribute(verificationElement, kAXValueAttribute as CFString)
				performed["grounding"] = "keyboard-events"
				performed["delivery"] = delivery
				performed["selectionGrounding"] = selected ? "ax" : "keyboard"
				if value == text { return finish(["outcome": "worked", "performed": performed, "evidence": ["value": text]]) }
				// The replacement text was posted, so a stale or failed readback may hide text that landed: unknown, never
				// `didnt`, which would read as not delivered and invite a replay.
				var evidence: [String: Any] = ["deliveryUnknown": true]
				if let value { evidence["value"] = value }
				return finish(["outcome": "unknown", "performed": performed, "evidence": evidence])
			}
			var targetElement = element
			var status = world.setAttribute(targetElement, kAXValueAttribute as CFString, text as CFTypeRef)
			if status != .success, let refreshed = refreshElement() {
				targetElement = refreshed
				status = world.setAttribute(targetElement, kAXValueAttribute as CFString, text as CFTypeRef)
			}
			if status == .success {
				performed["grounding"] = "description"
				performed["delivery"] = "ax"
				let value = world.stringAttribute(targetElement, kAXValueAttribute as CFString)
				if value == text { return finish(["outcome": "worked", "performed": performed, "evidence": ["value": text]]) }
				// The write was accepted, so a stale or failed readback may hide a value that landed: unknown, never
				// `didnt` or `foreground_required`, either of which invites a second write (#1290).
				var evidence: [String: Any] = ["deliveryUnknown": true]
				if let value { evidence["value"] = value }
				return finish(["outcome": "unknown", "performed": performed, "evidence": evidence])
			}
			// `setText` has no coordinate form: a refused write is reported as is, with no lock, activation or hit test (#1365).
			performed["grounding"] = "description"
			performed["delivery"] = "ax"
			return finish(["outcome": "didnt", "performed": performed, "error": ["code": "ax_write_failed", "message": "The element refused AXValue (AXError \(status.rawValue))"]])
		} else if action == "typeText" {
			try rejectInStrictHeadless("Typing requires synthesized keyboard input, which strict headless mode prohibits")
			let preserveFocus = params["preserveFocus"] as? Bool ?? false
			if let element {
				let focused = world.setAttribute(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
				if focused == .success { performed["focused"] = true }
			}
			acquirePhysicalInputIfNeeded()
			// HID keys reach the focused app, which a non-activating panel of a blocked app can be.
			try refuseBlockedKeyboardAfterFocus(preserveFocus: preserveFocus)
			let text = params["text"] as? String ?? ""
			try keyboard.deliver { try world.postUnicodeText(text, pid, delivery, admitKeyboard) }
			performed["grounding"] = "coordinates"
			if let element, !text.isEmpty {
				world.sleep(30_000)
				let afterValue = world.stringAttribute(element, kAXValueAttribute as CFString)
				// Only two successful reads that differ confirm the posted text; a failed read never stands in for a value.
				let changed = beforeValue != nil && afterValue != nil && afterValue != beforeValue
				var evidence: [String: Any] = ["valueChanged": changed]
				if let afterValue { evidence["value"] = afterValue }
				// The text was posted: an unconfirmed readback is unknown, never didnt, which would invite a resend (#1241).
				if !changed { evidence["deliveryUnknown"] = true }
				return finish(["outcome": changed ? "worked" : "unknown", "performed": performed, "evidence": evidence])
			}
		} else if let element, action == "secondaryAction" {
			// AX-only: runs one action the element itself advertises, checked live against its current action list.
			guard let name = params["name"] as? String, name.hasPrefix("AX"), name.count > 2 else {
				throw BridgeFailure(message: "secondaryAction requires an AX action name", code: "invalid_args")
			}
			var targetElement = element
			if !world.supportsAction(targetElement, name as CFString) {
				guard let refreshed = refreshElement(), world.supportsAction(refreshed, name as CFString) else {
					throw BridgeFailure(message: "Element does not advertise \(name)", code: "action_unsupported")
				}
				targetElement = refreshed
			}
			var status = world.performAction(targetElement, name as CFString)
			if status != .success, secondaryActionRetryIsSafe(axError: status.rawValue), let refreshed = refreshElement(), world.supportsAction(refreshed, name as CFString) {
				status = world.performAction(refreshed, name as CFString)
			}
			performed["grounding"] = "description"
			performed["delivery"] = "ax"
			performed["action"] = name
			guard status == .success else {
				return finish(["outcome": secondaryActionFailureOutcome(axError: status.rawValue), "performed": performed, "error": ["code": "ax_action_failed", "message": "\(name) failed (AXError \(status.rawValue))"]])
			}
			// Menus and sheets open asynchronously; the root delta and window check below see them.
			world.sleep(60_000)
		} else if let element, action == "selectText" {
			// AX-only: AXSelectedTextRange is in UTF-16 units, like NSString.
			guard let start = (params["start"] as? NSNumber)?.intValue else {
				throw BridgeFailure(message: "selectText requires start", code: "invalid_args")
			}
			let length = (params["length"] as? NSNumber)?.intValue ?? 0
			let valueLength = world.stringAttribute(element, kAXValueAttribute as CFString).map { ($0 as NSString).length }
			if let issue = selectionRangeIssue(start: start, length: length, valueLength: valueLength) {
				throw BridgeFailure(message: issue, code: "invalid_args")
			}
			var range = CFRange(location: start, length: length)
			guard let axRange = AXValueCreate(.cfRange, &range) else {
				throw BridgeFailure(message: "Could not encode the selection range", code: "invalid_args")
			}
			var targetElement = element
			var status = world.setAttribute(targetElement, kAXSelectedTextRangeAttribute as CFString, axRange)
			if status != .success, let refreshed = refreshElement() {
				targetElement = refreshed
				status = world.setAttribute(targetElement, kAXSelectedTextRangeAttribute as CFString, axRange)
			}
			performed["grounding"] = "description"
			performed["delivery"] = "ax"
			guard status == .success else {
				return finish(["outcome": "didnt", "performed": performed, "error": ["code": "ax_write_failed", "message": "The element refused AXSelectedTextRange (AXError \(status.rawValue))"]])
			}
			var readBack: (location: Int, length: Int)?
			if let raw = world.copyAttribute(targetElement, kAXSelectedTextRangeAttribute as CFString), CFGetTypeID(raw) == AXValueGetTypeID() {
				var actual = CFRange()
				if AXValueGetValue(raw as! AXValue, .cfRange, &actual) { readBack = (actual.location, actual.length) }
			}
			var evidence: [String: Any] = [:]
			if let readBack { evidence["selection"] = ["start": readBack.location, "length": readBack.length] }
			return finish(["outcome": selectionOutcome(requested: (start, length), readBack: readBack), "performed": performed, "evidence": evidence])
		} else if action == "paste" {
			try rejectInStrictHeadless("Paste requires synthesized keyboard input, which strict headless mode prohibits")
			let preserveFocus = params["preserveFocus"] as? Bool ?? false
			let text = params["text"] as? String ?? ""
			guard !text.isEmpty else { throw BridgeFailure(message: "paste requires non-empty text", code: "invalid_args") }
			if let element {
				let focused = world.setAttribute(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
				if focused == .success { performed["focused"] = true }
			}
			var valueMoved = false
			acquirePhysicalInputIfNeeded()
			// cmd+v reaches the focused app under HID delivery: refuse a blocked one BEFORE the clipboard is touched.
			try refuseBlockedKeyboardAfterFocus(preserveFocus: preserveFocus)
			let clipboard = world.snapshotClipboard(text)
			// Lazy pasteboard data can stall the snapshot while focus moves. Do not publish if it moved to a blocked app.
			try recheckBlockedKeyboard()
			let restored = try withRestoredClipboard(write: clipboard.write, restore: clipboard.restore) {
				// Looked up first, inside the clipboard: activating the target can switch the input source, and the lookup
				// (a main-queue hop plus layout translation) must not sit between the last focus check and the post. Throwing restores the clipboard.
				guard let vKeyCode = world.pasteKeyCode() else {
					throw BridgeFailure(message: "The active keyboard layout is unreadable, so cmd+v cannot be sent", code: "layout_unsupported")
				}
				try keyboard.deliver { try world.postKeyCode(CGKeyCode(vKeyCode), .maskCommand, pid, delivery, { _, posting in try admitKeyboard(true, posting) }) }
				// The target reads the pasteboard asynchronously: restore once the value moved, or at the deadline.
				for attempt in 0..<10 {
					world.sleep(30_000)
					if attempt >= 2, let element, world.stringAttribute(element, kAXValueAttribute as CFString) != beforeValue { valueMoved = true; break }
				}
			}
			performed["grounding"] = "coordinates"
			performed["clipboardRestored"] = restored
			// A slow target can still read the pasteboard after the restore and paste the OLD clipboard.
			if !valueMoved { performed["pasteDeadlineExpired"] = true }
			let afterValue = element.flatMap { world.stringAttribute($0, kAXValueAttribute as CFString) }
			let outcome = pasteOutcome(valueBefore: element == nil ? nil : beforeValue, valueAfter: afterValue)
			var evidence: [String: Any] = [:]
			if let afterValue { evidence["value"] = afterValue; evidence["valueChanged"] = afterValue != (beforeValue ?? "") }
			return finish(["outcome": outcome, "performed": performed, "evidence": evidence])
		} else if action == "keypress" {
			try rejectInStrictHeadless("Keypress requires synthesized keyboard input, which strict headless mode prohibits")
			let preserveFocus = params["preserveFocus"] as? Bool ?? false
			guard let keys = params["keys"] as? [String], !keys.isEmpty else {
				throw BridgeFailure(message: "keypress requires keys", code: "invalid_args")
			}
			if let element {
				let focused = world.setAttribute(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
				if focused == .success { performed["focused"] = true }
				let normalizedKeys = keys.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
				if normalizedKeys.count == 2,
					normalizedKeys.last == "a",
					["cmd", "command", "meta"].contains(normalizedKeys.first ?? ""),
					let value = world.stringAttribute(element, kAXValueAttribute as CFString)
				{
					var range = CFRange(location: 0, length: (value as NSString).length)
					if let selection = AXValueCreate(.cfRange, &range),
						world.setAttribute(element, kAXSelectedTextRangeAttribute as CFString, selection) == .success
					{
						performed["selectionGrounding"] = "ax"
					}
				}
			}
			acquirePhysicalInputIfNeeded()
			try refuseBlockedKeyboardAfterFocus(preserveFocus: preserveFocus)
			try keyboard.deliver { try world.postKeyPress(keys, pid, delivery, admitKeyboard) }
			performed["grounding"] = "coordinates"
		} else if let element, action == "scroll" {
			let cursorPoint = try? coordinatePoint()
			let before = world.scrollSignature(element)
			let scroll = ActScrollRequest(targetPid: pid, scrollX: (params["scrollX"] as? NSNumber)?.intValue ?? 0,
				scrollY: (params["scrollY"] as? NSNumber)?.intValue ?? 0, steps: 1, point: cursorPoint)
			let result = world.scrollAction(element, scroll)
			if (result["scrolled"] as? Bool) == true {
				performed["grounding"] = "description"
				performed["delivery"] = "ax"
				if let cursorPoint { animateCursor(at: cursorPoint) }
				let after = world.scrollSignature(element)
				return finish(["outcome": before != after ? "worked" : "unknown", "performed": performed])
			}
			// SwiftUI and many AppKit scroll areas expose no scroll actions and can
			// ignore wheel events posted to a background app, but accept a write to
			// their scroll bar's value.
			if let write = world.scrollBar(element, scroll) {
				performed["grounding"] = "description"
				performed["delivery"] = "ax"
				performed["axScroll"] = "scroll_bar_value"
				if let cursorPoint { animateCursor(at: cursorPoint) }
				var barEvidence: [String: Any] = [:]
				if let value = write.value { barEvidence["scrollBarValue"] = value }
				if write.remainingX == 0 && write.remainingY == 0 {
					// An unconfirmed write was accepted but not yet visible: it is delivered, so never add a wheel on top.
					if !write.confirmed { performed["axScroll"] = "scroll_bar_value_unconfirmed" }
					return finish(["outcome": write.confirmed ? "worked" : "unknown", "performed": performed, "evidence": barEvidence])
				}
				// Only some requested axes were written: deliver the rest with the wheel, never report them as handled.
				performed["axScroll"] = "scroll_bar_value_partial"
				if policy == "ax_only" {
					barEvidence["unmovedScrollX"] = write.remainingX
					barEvidence["unmovedScrollY"] = write.remainingY
					return finish(["outcome": "unknown", "performed": performed, "evidence": barEvidence])
				}
				wheelDeltaOverride = (write.remainingX, write.remainingY)
				scrollWriteUnconfirmed = !write.confirmed
				performed["delivery"] = delivery
				do {
					try executeCoordinates(coordinatePoint())
				} catch let failure as BridgeFailure {
					// The bar axis already scrolled: rethrowing would read as nothing delivered and a retry would scroll it twice.
					performed["grounding"] = "description"
					performed["delivery"] = "ax"
					barEvidence["error"] = ["code": failure.code, "message": failure.message]
					return finish(["outcome": "unknown", "performed": performed, "evidence": barEvidence])
				}
			} else {
				performed["axScroll"] = result["reason"] ?? "no_scroll_action"
				try executeCoordinates(coordinatePoint())
			}
		} else {
			try executeCoordinates(coordinatePoint())
		}

		let afterSheetCount = world.sheetCount(pid, record) ?? beforeSheetCount
		let windowChanged = beforeFocusedWindow != world.focusedWindow(pid) || beforeSheetCount != afterSheetCount
		var outcome = preflightCapsUnknown ? "unknown" : "unknown"
		var evidence: [String: Any] = [:]
		if let element, action == "press" || action == "click" || action == "secondaryAction" {
			let afterValue = world.stringAttribute(element, kAXValueAttribute as CFString)
			let afterSelected = world.stringAttribute(element, kAXSelectedTextAttribute as CFString)
			if beforeValue != afterValue || beforeSelected != afterSelected || windowChanged {
				outcome = "worked"
			}
		} else if windowChanged {
			outcome = "worked"
		}
		// The wheel heuristic cannot verify the bar axis whose write the read-back did not confirm.
		if scrollWriteUnconfirmed { outcome = "unknown" }
		if windowChanged { evidence["windowChanged"] = true }
		var response: [String: Any] = ["outcome": outcome, "performed": performed]
		if !evidence.isEmpty { response["evidence"] = evidence }
		return finish(response)
	}

	/// Snapshots every item and type without writing. The returned operations publish a transient item and
	/// restore the snapshot only while we still own the pasteboard change count.
	private func snapshotClipboard(_ text: String) -> (write: () throws -> Void, restore: () -> Bool) {
		let pasteboard = NSPasteboard.general
		let saved: [[NSPasteboard.PasteboardType: Data]] = (pasteboard.pasteboardItems ?? []).map { item in
			var entry: [NSPasteboard.PasteboardType: Data] = [:]
			for type in item.types { if let data = item.data(forType: type) { entry[type] = data } }
			return entry
		}
		var ownChangeCount = Int.min
		func restore() -> Bool {
			guard clipboardRestoreIsSafe(changeCountAfterWrite: ownChangeCount, changeCountNow: pasteboard.changeCount) else { return false }
			// Always host-only: the original may be a host-only secret, and a plain clear would republish it as syncable.
			pasteboard.prepareForNewContents(with: .currentHostOnly)
			let items = saved.map { entry -> NSPasteboardItem in
				let item = NSPasteboardItem()
				for (type, data) in entry { item.setData(data, forType: type) }
				return item
			}
			return items.isEmpty || pasteboard.writeObjects(items)
		}
		return (write: {
			// Keep the pasted text off Universal Clipboard / Handoff: it must not sync to the user's other devices.
			pasteboard.prepareForNewContents(with: .currentHostOnly)
			ownChangeCount = pasteboard.changeCount
			let item = NSPasteboardItem()
			item.setString(text, forType: .string)
			for identifier in pasteTransientTypeIdentifiers { item.setData(Data(), forType: NSPasteboard.PasteboardType(identifier)) }
			guard pasteboard.writeObjects([item]) else {
				throw BridgeFailure(message: "The clipboard rejected the text", code: "clipboard_write_failed")
			}
			ownChangeCount = pasteboard.changeCount
		}, restore: restore)
	}

	private func actBatch(_ request: [String: Any]) throws -> [String: Any] {
		try actBatch(request, world: actionWorld(), supportsAgentCursor: supportsAgentCursor)
	}

	func actBatch(_ request: [String: Any], world: ActWorld, supportsAgentCursor: Bool) throws -> [String: Any] {
		guard let actions = request["actions"] as? [[String: Any]], !actions.isEmpty, actions.count <= 20 else {
			throw BridgeFailure(message: "actBatch requires 1...20 actions", code: "invalid_args")
		}
		let pids = try actions.map(pidArg)
		let pid = pids[0]
		let lookId = try stringArg(actions[0], "lookId")
		guard pids.allSatisfy({ $0 == pid }) else {
			throw BridgeFailure(message: "actBatch actions must target one pid", code: "invalid_args")
		}
		guard actions.allSatisfy({ ($0["lookId"] as? String) == lookId }) else {
			throw BridgeFailure(message: "actBatch actions must belong to one look", code: "invalid_args")
		}
		// Reject a malformed drag before the transaction takes its outer HID lock. A ref target's point exists
		// only once its step runs; act then rejects it before that step's own focus, preflight or allocation.
		let drags = actions.filter { $0["action"] as? String == "drag" }
		if !drags.isEmpty {
			guard let record = world.lookRecord(lookId) else {
				throw BridgeFailure(message: "Look id '\(lookId)' is no longer available", code: "stale_look")
			}
			for drag in drags {
				let point = coordinateTargetPoint(drag["target"] as? [String: Any] ?? [:], record: record)
				_ = try admittedDragPoints(at: point, params: drag["params"] as? [String: Any] ?? [:], record: record)
			}
		}
		let finish = world.beginRootDelta(pid)
		let mayUsePhysicalInput = actions.contains { action in
			(optionalStringArg(action, "policy") ?? "default") != "ax_only"
		}
		if mayUsePhysicalInput { world.lockInput() }
		defer { if mayUsePhysicalInput { world.unlockInput() } }

		// Resolved once for the whole transaction, so a missing deadline cannot restart its 30 s fallback per step.
		let deadlineMs = keyboardDeadline(request, now: ProcessInfo.processInfo.systemUptime, ceiling: nil) * 1000
		var steps: [[String: Any]] = []
		var stoppedAt: Int?
		for (index, action) in actions.enumerated() {
			var deferred = action
			deferred["deferRootDelta"] = true
			deferred["keyboardDeadlineUptimeMs"] = deadlineMs
			do {
				let step = try act(deferred, world: world, supportsAgentCursor: supportsAgentCursor)
				steps.append(step)
				if (step["outcome"] as? String) == "didnt" || stepDeliveryUnknown(step) { stoppedAt = index; break }
			} catch let failure as BridgeFailure {
				var step: [String: Any] = ["outcome": "didnt", "error": ["code": failure.code, "message": failure.message]]
				if let evidence = failure.evidence { step["evidence"] = evidence }
				steps.append(step)
				stoppedAt = index
				break
			}
		}
		let outcomes = steps.compactMap { $0["outcome"] as? String }
		let outcome = outcomes.contains("didnt") ? "didnt" : (outcomes.contains("unknown") ? "unknown" : "worked")
		var response: [String: Any] = ["outcome": outcome, "performed": ["transaction": true, "actionCount": steps.count], "steps": steps]
		if let stoppedAt { response["stoppedAt"] = stoppedAt }
		return finish(response)
	}

	func rootIdentity(_ root: [String: Any]) -> String {
		if let windowId = root["windowId"] as? Int, windowId > 0 { return "window:\(windowId)" }
		// AXUIElement CFEqual/CFHash are not stable after re-enumeration for all
		// transient roots; use the metadata tuple that comes from the cheap pass.
		let kind = root["kind"] as? String ?? "window"
		let title = root["title"] as? String ?? ""
		let role = root["role"] as? String ?? ""
		let frame = root["framePoints"] as? [String: Any] ?? [:]
		let coordinates = ["x", "y", "w", "h"].map { identityCoordinate(frame[$0]) }
		return "meta:\(kind):\(role):\(title):\(coordinates.map(String.init).joined(separator: ","))"
	}

	/// Truncate a frame coordinate toward zero without trapping: a missing value, NaN, an infinity or a
	/// value outside `Int` reads as 0.
	private func identityCoordinate(_ value: Any?) -> Int {
		guard let number = (value as? NSNumber)?.doubleValue else { return 0 }
		return Int(exactly: number.rounded(.towardZero)) ?? 0
	}

	private func rootMetadataSnapshot(pid: Int32) -> RootInventorySnapshot {
		let inventory = rootInventory(pid: pid, title: nil)
		return RootInventorySnapshot(roots: inventory.roots, complete: inventory.complete, unidentifiedRefs: inventory.unidentified, identity: rootIdentity)
	}

	private func rootDelta(before: RootInventorySnapshot, beforeFrontmostPid: pid_t?, pid: Int32) -> [[String: Any]] {
		var delta = rootSnapshotDelta(before: before, after: rootMetadataSnapshot(pid: pid), pid: pid)
		if let beforeFrontmostPid, beforeFrontmostPid != NSWorkspace.shared.frontmostApplication?.processIdentifier {
			if let frontmost = NSWorkspace.shared.frontmostApplication {
				delta.append(["change": "focused", "kind": "app", "title": frontmost.localizedName ?? processName(pid: frontmost.processIdentifier) ?? "Unknown App", "pid": Int(frontmost.processIdentifier)])
			}
		}
		return delta
	}

	/// Compare two root listings keyed by `rootIdentity` (see `rootInventoryChanges`): appeared roots, then
	/// closed roots, then roots that gained focus. Absence from an incomplete listing proves nothing.
	func rootSnapshotDelta(before: RootInventorySnapshot, after: RootInventorySnapshot, pid: Int32) -> [[String: Any]] {
		rootInventoryChanges(before: before, after: after).map { rootDeltaItem(change: $0.change, root: $0.root, pid: pid) }
	}

	func rootDeltaItem(change: String, root: [String: Any], pid: Int32) -> [String: Any] {
		var item: [String: Any] = ["change": change, "kind": root["kind"] as? String ?? "window", "title": root["title"] as? String ?? "", "pid": root["pid"] as? Int ?? Int(pid)]
		if let isModal = root["isModal"] as? Bool { item["isModal"] = isModal }
		if let metadata = root["metadata"] as? [String: Any] { item["metadata"] = metadata }
		if let ref = root["rootRef"] as? String ?? root["windowRef"] as? String { item["ref"] = ref }
		return item
	}

	// The AX snapshot diff is authoritative: macOS emits no AXObserver
	// notification at all when a sheet appears (verified on macOS 26), so
	// events can only accelerate the decision, never make it. A cheap
	// CGWindowList id-set poll detects real-window appearance/closure early;
	// the AX diff runs once at the first signal or at timeout.
	private func attachRootDelta(to response: [String: Any], before: RootInventorySnapshot, beforeFrontmostPid: pid_t?, pid: Int32, eventsLive: Bool, eventCursor: UInt64, beforeCgSignature: Set<UInt32>) -> [String: Any] {
		var output = response
		var performed = output["performed"] as? [String: Any] ?? [:]

		// AXUIElementDestroyed is deliberately not a signal: it fires for every
		// rebuilt list row; a genuinely closed root also leaves the CG set.
		let signalNotifications: Set<String> = ["AXWindowCreated", "AXSheetCreated", "AXMenuOpened", "AXMenuClosed", "AXFocusedWindowChanged"]
		var source = "snapshot"
		let deadline = Date().addingTimeInterval(0.40)
		while Date() < deadline {
			if cgRootSignature(pid: pid) != beforeCgSignature { source = "cg-poll"; break }
			if let beforeFrontmostPid, NSWorkspace.shared.frontmostApplication?.processIdentifier != beforeFrontmostPid { source = "cg-poll"; break }
			if eventsLive && rootEvents(pid: pid, since: eventCursor).contains(where: { signalNotifications.contains($0.notification) }) { source = "events"; break }
			usleep(30_000)
		}

		var delta = rootDelta(before: before, beforeFrontmostPid: beforeFrontmostPid, pid: pid)
		if delta.isEmpty && source != "snapshot" {
			// A signal fired but the AX tree can lag the CG window; give it a
			// bounded moment to catch up.
			for _ in 0..<3 where delta.isEmpty {
				usleep(80_000)
				delta = rootDelta(before: before, beforeFrontmostPid: beforeFrontmostPid, pid: pid)
			}
		}
		performed["deltaSource"] = source
		output["performed"] = performed
		if !delta.isEmpty { output["rootDelta"] = delta }
		return output
	}

	func focusedWindowSummary(pid: Int32) -> String {
		let app = AXUIElementCreateApplication(pid)
		guard let element = copyAttribute(app, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement) else { return "none" }
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let title = stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? ""
		return "\(role):\(title)"
	}

	func scrollPositionSignature(_ element: AXUIElement) -> String {
		let names: [CFString] = ["AXVerticalScrollBar" as CFString, "AXHorizontalScrollBar" as CFString, kAXValueAttribute as CFString]
		return names.map { String(describing: copyAttribute(element, attribute: $0) ?? "" as CFTypeRef) }.joined(separator: "|")
	}

	private func axWaitFor(_ request: [String: Any]) throws -> [String: Any] {
		let pid = try pidArg(request)
		let windowId = try checkedWindowId(request["windowId"])
		ensureEnhancedAccessibility(pid: pid)
		let windowRef = optionalStringArg(request, "windowRef")
		let role = optionalStringArg(request, "role")?.trimmingCharacters(in: .whitespacesAndNewlines)
		let text = optionalStringArg(request, "text")?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let expectedValue = optionalStringArg(request, "value")?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let waitForGone = boolArg(request, "gone") ?? false
		let scopeExact = boolArg(request, "scopeExact") ?? false
		let timeoutMs = max(100, min(60_000, optionalIntArg(request, "timeoutMs") ?? 10_000))
		let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
		guard role?.isEmpty == false || text?.isEmpty == false || expectedValue?.isEmpty == false else {
			throw BridgeFailure(message: "axWaitFor requires role, text, or value", code: "invalid_args")
		}
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			return ["found": false, "reason": "window_not_found"]
		}
		let rootElement: AXUIElement
		if let scopeRef = optionalStringArg(request, "scopeRef") {
			guard let scoped = refStore.element(for: scopeRef), isElement(scoped, descendantOf: window) else {
				throw BridgeFailure(message: "Condition scope ref is stale or outside the target root", code: "element_ref_invalid")
			}
			rootElement = scoped
		} else {
			rootElement = window
		}
		_ = ensureRootObserver(pid: pid)

		func field(_ element: AXUIElement, _ field: AXWaitField) -> AXStringRead {
			switch field {
			case .role: return self.stringRead(element, attribute: kAXRoleAttribute as CFString)
			case .title: return self.stringRead(element, attribute: kAXTitleAttribute as CFString)
			case .description: return self.stringRead(element, attribute: kAXDescriptionAttribute as CFString)
			case .value:
				// A secure field never exposes its value; an unreadable role or subrole cannot rule one out.
				let role = self.stringRead(element, attribute: kAXRoleAttribute as CFString)
				let subrole = self.stringRead(element, attribute: kAXSubroleAttribute as CFString)
				if role == .value("AXSecureTextField") || subrole == .value("AXSecureTextField") { return .value("") }
				if role == .failed || subrole == .failed { return .failed }
				return self.stringRead(element, attribute: kAXValueAttribute as CFString)
			}
		}

		var lastCount = 0
		var lastUndecided = false
		repeat {
			let changeGeneration = rootChangeGeneration(pid: pid)
			let pass = descendantWorld().waitPass(startingAt: rootElement, scopeExact: scopeExact) { element in
				axWaitConditionMatch(role: role, text: text, value: expectedValue) { field(element, $0) }
			}
			let descendants = pass.nodes
			lastCount = descendants.count
			var found: AXDescendant<AXUIElement>?
			lastUndecided = false
			switch pass.verdict {
			case .found(let match): found = match
			// Only a whole, fully read scope proves the condition gone.
			case .absent: if waitForGone { return ["found": true, "gone": true, "complete": true, "nodeCount": lastCount] }
			case .undecided: lastUndecided = true
			}
			if let match = found {
				if waitForGone {
					waitForRootChange(pid: pid, since: changeGeneration, until: deadline)
					continue
				}
				let candidateRole = self.stringAttribute(match.element, attribute: kAXRoleAttribute as CFString) ?? ""
				let isBrowser = isBrowser(pid: pid)
				let containsWebArea = descendants.contains { self.stringAttribute($0.element, attribute: kAXRoleAttribute as CFString) == "AXWebArea" }
				return [
					"found": true,
					"target": self.elementPayload(
						element: match.element,
						key: "target",
						source: self.axSource(role: candidateRole, insideWebArea: match.insideWebArea, isBrowser: isBrowser, containsWebArea: containsWebArea)
					),
					"nodeCount": lastCount,
				]
			}
			waitForRootChange(pid: pid, since: changeGeneration, until: deadline)
		} while Date() < deadline

		var result: [String: Any] = ["found": false, "timedOut": true, "nodeCount": lastCount]
		// The last walk could neither find the condition nor prove it absent.
		if waitForGone && lastUndecided { result["incomplete"] = true }
		return result
	}

	/// The element at `point`. With `pid` the query goes to that app, so a covered window still hits its own
	/// elements; without it the system-wide element answers with whatever is frontmost there.
	private func hitTestElement(at point: CGPoint, pid: Int32? = nil) -> AXUIElement? {
		let root = pid.map { AXUIElementCreateApplication($0) } ?? AXUIElementCreateSystemWide()
		var hitElement: AXUIElement?
		let status = AXUIElementCopyElementAtPosition(root, Float(point.x), Float(point.y), &hitElement)
		guard status == .success, let hitElement else { return nil }
		return hitElement
	}

	private let axScrollDownAction = "AXScrollDown" as CFString
	private let axScrollUpAction = "AXScrollUp" as CFString
	private let axScrollLeftAction = "AXScrollLeft" as CFString
	private let axScrollRightAction = "AXScrollRight" as CFString

	private func scrollActionNames(scrollX: Int, scrollY: Int) -> [CFString] {
		var actions: [CFString] = []
		if scrollY > 0 { actions.append(axScrollDownAction) }
		if scrollY < 0 { actions.append(axScrollUpAction) }
		if scrollX > 0 { actions.append(axScrollRightAction) }
		if scrollX < 0 { actions.append(axScrollLeftAction) }
		return actions
	}

	func supportsAnyScrollAction(_ element: AXUIElement) -> Bool {
		let actions = Set(actionNames(element))
		return actions.contains(axScrollDownAction as String) || actions.contains(axScrollUpAction as String) || actions.contains(axScrollLeftAction as String) || actions.contains(axScrollRightAction as String)
	}

	private func scrollWorld() -> AXScrollWorld {
		AXScrollWorld(pid: pidForElement, parent: parentElement, supportsAction: supportsAction(_:action:),
			performAction: AXUIElementPerformAction, role: { self.stringAttribute($0, attribute: kAXRoleAttribute as CFString) },
			hitTest: hitTestElement(at:pid:), sameElement: sameElement, writeBar: setScrollBarValue(area:barAttribute:delta:vertical:))
	}

	func performScrollActionOrAncestor(startingAt element: AXUIElement, request: ActScrollRequest, world: AXScrollWorld) -> [String: Any] {
		let actions = scrollActionNames(scrollX: request.scrollX, scrollY: request.scrollY)
		guard !actions.isEmpty else { return ["scrolled": false, "reason": "zero_delta"] }
		var current: AXUIElement? = element
		var depth = 0

		while let candidate = current, depth < 10 {
			if let pid = world.pid(candidate), pid != request.targetPid {
				return ["scrolled": false, "reason": "pid_mismatch", "ownerPid": Int(pid)]
			}
			var didScroll = false
			for _ in 0..<request.steps {
				for action in actions where world.supportsAction(candidate, action) {
					let status = world.performAction(candidate, action)
					if status == .success { didScroll = true }
				}
			}
			if didScroll { return ["scrolled": true] }
			current = world.parent(candidate)
			depth += 1
		}

		return ["scrolled": false, "reason": "no_scroll_action"]
	}

	/// Moves scroll areas at or above `element` by writing their scroll bar values, one requested axis at a time.
	/// Only an area that `scrollBarWriteAllowed` accepts is written, so a ref inside an inner wheel-scrollable
	/// region falls through to the wheel instead of scrolling the outer area. Returns the last value read back
	/// (nil when no write was confirmed), whether every written axis was confirmed, and the deltas no bar
	/// delivered. Nil when no bar was written.
	func setScrollBarValueOrAncestor(startingAt element: AXUIElement, request: ActScrollRequest, world: AXScrollWorld) -> ActWorld.ScrollBarWrite? {
		var remaining = (x: request.scrollX, y: request.scrollY)
		var value: Double?
		var anyWritten = false
		var confirmed = true
		var hitArea: AXUIElement??
		func hitTestResolves(to area: AXUIElement) -> Bool {
			if hitArea == nil {
				var found: AXUIElement?
				if let point = request.point, var hit = world.hitTest(point, world.pid(element) ?? request.targetPid) {
					var hops = 0
					while hops < 10 {
						if world.role(hit) == (kAXScrollAreaRole as String) { found = hit; break }
						guard let parent = world.parent(hit) else { break }
						hit = parent
						hops += 1
					}
				}
				hitArea = .some(found)
			}
			if case .some(.some(let found)) = hitArea { return world.sameElement(found, area) }
			return false
		}
		var current: AXUIElement? = element
		var depth = 0
		while let candidate = current, depth < 10, remaining.x != 0 || remaining.y != 0 {
			if let pid = world.pid(candidate), pid != request.targetPid { break }
			if world.role(candidate) == (kAXScrollAreaRole as String) {
				guard scrollBarWriteAllowed(depthFromStart: depth, hitTestResolvesToArea: depth <= 1 ? false : hitTestResolves(to: candidate)) else { break }
				let writeY = remaining.y != 0 ? world.writeBar(candidate, "AXVerticalScrollBar", remaining.y, true) : (write: ScrollAxisWrite.notWritten, value: nil)
				let writeX = remaining.x != 0 ? world.writeBar(candidate, "AXHorizontalScrollBar", remaining.x, false) : (write: ScrollAxisWrite.notWritten, value: nil)
				remaining = remainingScroll(requestedX: remaining.x, requestedY: remaining.y, x: writeX.write, y: writeY.write)
				if writeX.write != .notWritten || writeY.write != .notWritten { anyWritten = true }
				if !scrollWritesConfirmed(x: writeX.write, y: writeY.write) { confirmed = false }
				if let moved = writeY.value ?? writeX.value { value = moved }
			}
			current = world.parent(candidate)
			depth += 1
		}
		guard anyWritten else { return nil }
		return (value, remaining.x, remaining.y, confirmed)
	}

	/// Moves one scroll bar of `area` by `delta` points: reads the bar value, viewport and content length (falling
	/// back to the thumb/track ratio when the area reports no content), writes the new value and classifies the
	/// write: `moved` with the value when the read-back shows the bar moved, `unconfirmed` when the set call
	/// succeeded but the read-back is unchanged or unreadable (async apps apply it late), `notWritten` when the bar
	/// is missing, unsettable, at its end or the set call failed.
	private func setScrollBarValue(area: AXUIElement, barAttribute: String, delta: Int, vertical: Bool) -> (write: ScrollAxisWrite, value: Double?) {
		let none: (write: ScrollAxisWrite, value: Double?) = (.notWritten, nil)
		guard let barObject = copyAttribute(area, attribute: barAttribute as CFString),
			CFGetTypeID(barObject as CFTypeRef) == AXUIElementGetTypeID()
		else { return none }
		let bar = unsafeBitCast(barObject, to: AXUIElement.self)
		var settable = DarwinBoolean(false)
		guard AXUIElementIsAttributeSettable(bar, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue,
			let current = (copyAttribute(bar, attribute: kAXValueAttribute as CFString) as? NSNumber)?.doubleValue,
			let viewport = sizeAttribute(area, attribute: kAXSizeAttribute as CFString)
		else { return none }
		let length = { (size: CGSize) in Double(vertical ? size.height : size.width) }
		let content = sizeAttribute(area, attribute: "AXContentSize" as CFString).map(length)
		let thumb = axElementArray(bar, attribute: kAXChildrenAttribute as CFString)
			.first { stringAttribute($0, attribute: kAXRoleAttribute as CFString) == (kAXValueIndicatorRole as String) }
			.flatMap { sizeAttribute($0, attribute: kAXSizeAttribute as CFString) }
			.map(length)
		let track = sizeAttribute(bar, attribute: kAXSizeAttribute as CFString).map(length)
		guard let target = scrollBarTargetValue(current: current, delta: delta, viewportLength: length(viewport), contentLength: content, thumbLength: thumb, trackLength: track),
			AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: target)) == .success
		else { return none }
		guard let after = (copyAttribute(bar, attribute: kAXValueAttribute as CFString) as? NSNumber)?.doubleValue, abs(after - current) > 0.0001 else { return (.unconfirmed, nil) }
		return (.moved, after)
	}

	private func windowElement(pid: Int32, windowId: UInt32?, windowRef: String? = nil) -> AXUIElement? {
		if let windowRef, let stored = refStore.window(for: windowRef) {
			AXUIElementSetMessagingTimeout(stored, 1.0)
			var ownerPid: pid_t = 0
			if AXUIElementGetPid(stored, &ownerPid) == .success, ownerPid == pid {
				return stored
			}
		}

		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 1.0)
		let windows = Array(axElementArray(appElement, attribute: kAXWindowsAttribute as CFString).prefix(128))
		guard !windows.isEmpty else { return nil }
		guard let windowId else {
			// A requested ref that no longer resolves must fail, never fall back to another window.
			return allowsFirstWindowFallback(windowId: windowId, windowRef: windowRef) ? windows.first : nil
		}
		let candidates = cgWindowCandidates(pid: pid)
		let pairings = windowPairings(windows: windows, candidates: candidates)
		if let window = windows.first(where: { pairings[ObjectIdentifier($0)]?.candidate?.windowId == windowId }) { return window }
		let sheets = windows.flatMap { sheetElements(of: $0) }
		let sheetPairings = pairSheets(sheets, candidates: candidates, windowPairings: pairings, read: pairingRead)
		return sheets.first { sheetPairings[ObjectIdentifier($0)]?.candidate?.windowId == windowId }
	}

	private func ensureEnhancedAccessibility(pid: Int32) {
		enhancedAccessibilityLock.lock()
		let inserted = enhancedAccessibilityPids.insert(pid).inserted
		enhancedAccessibilityLock.unlock()
		if !inserted { return }
		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 0.25)
		let enhancedStatus = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
		let manualStatus = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
		// Chromium-family apps often materialize web-content AX asynchronously
		// after these toggles. Pay a small one-time settle cost per pid so the
		// first tree walk is less likely to see browser chrome only.
		if isBrowser(pid: pid) && (enhancedStatus == .success || manualStatus == .success) {
			Thread.sleep(forTimeInterval: 0.35)
		}
	}

	private func isBrowser(pid: Int32) -> Bool {
		let app = NSRunningApplication(processIdentifier: pid)
		if browserBundleIds.contains(app?.bundleIdentifier ?? "") { return true }
		let name = (app?.localizedName ?? processName(pid: pid) ?? "").lowercased()
		return ["chrome", "chromium", "brave", "edge", "vivaldi", "opera", "firefox", "helium"].contains { name.contains($0) }
	}

	func collectDescendants(startingAt root: AXUIElement, maxDepth: Int, maxNodes: Int = 5000) -> [AXUIElement] {
		collectDescendantsWithContext(startingAt: root, maxDepth: maxDepth, maxNodes: maxNodes).map(\.element)
	}

	private func collectDescendantsWithContext(startingAt root: AXUIElement, maxDepth: Int, maxNodes: Int = 5000) -> [AXDescendant<AXUIElement>] {
		descendantWorld().collect(startingAt: root, maxDepth: maxDepth, maxNodes: maxNodes)
	}

	private func descendantWorld() -> AXTraversalWorld<AXUIElement> {
		AXTraversalWorld<AXUIElement>(
			role: { self.stringAttribute($0, attribute: kAXRoleAttribute as CFString) ?? "" },
			childLists: descendantChildLists,
			sameElement: sameElement, hash: axEquivalenceHash
		)
	}

	/// `nil` when the children could not be read; visibility reads only refine, so their failures are ignored.
	private func descendantChildLists(_ element: AXUIElement) -> (all: [AXUIElement], visible: [AXUIElement]?)? {
		guard let children = axElementArrayEvidence(element, attribute: kAXChildrenAttribute as CFString) else { return nil }
		let attributes: [CFString] = [
			kAXVisibleChildrenAttribute as CFString,
			kAXVisibleRowsAttribute as CFString,
			kAXVisibleColumnsAttribute as CFString,
			kAXVisibleCellsAttribute as CFString,
		]
		let visible = attributes.flatMap { axElementArray(element, attribute: $0) }
		return (children, visible.isEmpty ? nil : visible)
	}

	func axSource(role: String, insideWebArea: Bool, isBrowser: Bool, containsWebArea: Bool) -> String {
		if insideWebArea || role == "AXWebArea" { return "web_content_ax" }
		if isBrowser || containsWebArea { return "browser_chrome_ax" }
		return "desktop_ax"
	}

	func frameForElement(_ element: AXUIElement) -> CGRect? {
		let origin = pointAttribute(element, attribute: kAXPositionAttribute as CFString)
		let size = sizeAttribute(element, attribute: kAXSizeAttribute as CFString)
		guard let origin, let size, size.width > 0, size.height > 0 else { return nil }
		return CGRect(origin: origin, size: size)
	}

	func elementPayload(element: AXUIElement, key: String, score: Double? = nil, source: String? = nil, axVisible: Bool = true) -> [String: Any] {
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		let title = stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? ""
		let description = stringAttribute(element, attribute: kAXDescriptionAttribute as CFString) ?? ""
		let identifier = stringAttribute(element, attribute: "AXIdentifier" as CFString) ?? ""
		let value = displayValue(element, role: role, subrole: subrole)
		let frame = frameForElement(element)
		let parentFrame = copyAttribute(element, attribute: kAXParentAttribute as CFString).flatMap(asAXElement).flatMap(frameForElement)
		let centerX = frame.map { $0.midX } ?? 0
		let centerY = frame.map { $0.midY } ?? 0
		var valueSettable = DarwinBoolean(false)
		let valueStatus = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &valueSettable)
		var focusedSettable = DarwinBoolean(false)
		let focusedStatus = AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &focusedSettable)
		let actions = actionNames(element)
		let canSetValue = valueStatus == .success && valueSettable.boolValue
		let textRoles: Set<String> = [
			"AXTextField", "AXTextArea", "AXTextView", "AXSearchField", "AXComboBox", "AXEditableText", "AXSecureTextField",
		]
		var payload: [String: Any] = [
			key: true,
			"elementRef": refStore.storeElement(element),
			"role": role,
			"subrole": subrole,
			"title": title,
			"description": description,
			"identifier": identifier,
			"value": value,
			"actions": actions,
			"isTextInput": textRoles.contains(role),
			"canSetValue": canSetValue,
			"canFocus": focusedStatus == .success && focusedSettable.boolValue,
			"canPress": actions.contains(kAXPressAction as String),
			"canScroll": supportsAnyScrollAction(element),
			"canIncrement": actions.contains(kAXIncrementAction as String),
			"canDecrement": actions.contains(kAXDecrementAction as String),
			"axVisible": axVisible,
			"x": centerX,
			"y": centerY,
		]
		if let frame {
			payload["frame"] = ["x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height]
		}
		if let parentFrame {
			payload["parentFrame"] = ["x": parentFrame.origin.x, "y": parentFrame.origin.y, "w": parentFrame.width, "h": parentFrame.height]
		}
		if let score {
			payload["score"] = score
		}
		if let source {
			payload["source"] = source
		}
		return payload
	}

	func pidForElement(_ element: AXUIElement) -> Int32? {
		var pid: pid_t = 0
		let status = AXUIElementGetPid(element, &pid)
		guard status == .success else { return nil }
		return Int32(pid)
	}

	func parentElement(_ element: AXUIElement) -> AXUIElement? {
		guard let value = copyAttribute(element, attribute: kAXParentAttribute as CFString) else {
			return nil
		}
		return asAXElement(value)
	}

	func sameElement(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool {
		CFEqual(lhs as CFTypeRef, rhs as CFTypeRef)
	}

	func isElement(_ element: AXUIElement, descendantOf ancestor: AXUIElement) -> Bool {
		var current: AXUIElement? = element
		var depth = 0
		while let candidate = current, depth < 20 {
			if sameElement(candidate, ancestor) {
				return true
			}
			current = parentElement(candidate)
			depth += 1
		}
		return false
	}

	func hasAncestorRole(_ element: AXUIElement, role: String) -> Bool {
		var current: AXUIElement? = element
		var depth = 0
		while let candidate = current, depth < 30 {
			if stringAttribute(candidate, attribute: kAXRoleAttribute as CFString) == role { return true }
			current = parentElement(candidate)
			depth += 1
		}
		return false
	}

	func actionNames(_ element: AXUIElement) -> [String] {
		var actionsValue: CFArray?
		let status = AXUIElementCopyActionNames(element, &actionsValue)
		guard status == .success else { return [] }
		guard let actionsArray = actionsValue as? [AnyObject] else { return [] }
		return actionsArray.compactMap { $0 as? String }
	}

	func supportsAction(_ element: AXUIElement, action: CFString) -> Bool {
		actionNames(element).contains(action as String)
	}

	private func focusedElement(_ request: [String: Any]) throws -> [String: Any] {
		let pid = try pidArg(request)
		let windowId = try checkedWindowId(request["windowId"])
		let windowRef = optionalStringArg(request, "windowRef")
		let app = AXUIElementCreateApplication(pid)
		guard let focusedValue = copyAttribute(app, attribute: kAXFocusedUIElementAttribute as CFString),
			let element = asAXElement(focusedValue)
		else {
			return ["exists": false]
		}
		if windowId != nil || windowRef != nil {
			guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
				return ["exists": false, "reason": "window_not_found"]
			}
			guard isElement(element, descendantOf: window) else {
				return ["exists": false, "reason": "focused_element_outside_window"]
			}
		}

		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"

		var settable = DarwinBoolean(false)
		let settableStatus = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
		let canSetValue = settableStatus == .success && settable.boolValue

		let textRoles: Set<String> = [
			"AXTextField",
			"AXTextArea",
			"AXTextView",
			"AXSearchField",
			"AXComboBox",
			"AXEditableText",
			"AXSecureTextField",
		]

		let isTextInput = textRoles.contains(role) || canSetValue
		let elementRef = refStore.storeElement(element)

		return [
			"exists": true,
			"elementRef": elementRef,
			"role": role,
			"subrole": subrole,
			"isTextInput": isTextInput,
			"isSecure": secure,
			"canSetValue": canSetValue,
		]
	}

	private func axReadText(_ request: [String: Any]) throws -> [String: Any] {
		let elementRef = try stringArg(request, "elementRef")
		let offset = max(0, optionalIntArg(request, "offset") ?? 0)
		let limit = max(1, min(100_000, optionalIntArg(request, "limit") ?? 4_000))
		guard let element = refStore.element(for: elementRef) else {
			throw BridgeFailure(message: "Element reference is no longer valid", code: "element_ref_invalid")
		}
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		guard !isSecureTextElement(role: role, subrole: subrole) else {
			throw BridgeFailure(message: "Refers to a secure text field; refusing to read its value", code: "secure_text_unreadable")
		}
		guard let value = stringAttribute(element, attribute: kAXValueAttribute as CFString) else {
			throw BridgeFailure(message: "Element has no readable AXValue. Call snapshot/screenshot and choose a text-bearing ref.", code: "text_unavailable")
		}
		let characters = Array(value)
		if offset >= characters.count {
			return ["text": "", "offset": offset, "limit": limit, "totalChars": characters.count, "hasMore": false]
		}
		let end = min(characters.count, offset + limit)
		return [
			"text": String(characters[offset..<end]),
			"offset": offset,
			"limit": limit,
			"totalChars": characters.count,
			"hasMore": end < characters.count,
		]
	}

	// MARK: Whole-desktop control (global coordinates, HID delivery)

	/// Throws `app_blocked` when keyboard input would reach a blocked app: the frontmost one, or the system-wide
	/// focused one (a non-activating panel can hold key focus). An AX error leaves the frontmost check alone.
	private func keyboardAdmission(blocked: [String]?, deadline: TimeInterval) -> FocusCheck {
		let gate = KeyboardAdmission(now: { ProcessInfo.processInfo.systemUptime }, deadline: deadline)
		return { force in
			guard let blocked else { return try gate.checkDeadline() }
			try gate.check(force: force, frontmostPid: { NSWorkspace.shared.frontmostApplication?.processIdentifier }, focusedPid: self.systemFocusedPid) { pid in
				let app = NSRunningApplication(processIdentifier: pid)
				if isBlockedBundleId(app?.bundleIdentifier, blocked: blocked) {
					throw BridgeFailure(message: appBlockedMessage(app?.localizedName ?? "app", app?.bundleIdentifier), code: "app_blocked")
				}
			}
		}
	}


	/// The pid of the system-wide AX focused application, or nil when AX cannot say.
	private func systemFocusedPid() -> Int32? {
		var focused: CFTypeRef?
		let systemWide = AXUIElementCreateSystemWide()
		// Bound each focus probe: a hung focused app would otherwise block for the default AX messaging timeout.
		_ = AXUIElementSetMessagingTimeout(systemWide, 0.1)
		guard AXUIElementCopyAttributeValue(systemWide, kAXFocusedApplicationAttribute as CFString, &focused) == .success,
			let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
		var pid: pid_t = 0
		return AXUIElementGetPid(focused as! AXUIElement, &pid) == .success ? pid : nil
	}

	/// One on-screen window list snapshot, front to back, to reuse across the vertices of one action.
	private func onScreenWindowList() -> [[String: Any]] {
		CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
	}

	/// Refuses every point against one window-list snapshot; the AX hit test runs only at the endpoints.
	private func refuseBlockedPoints(_ points: [CGPoint], blocked: [String]) throws {
		let windows = onScreenWindowList()
		let hitIndices = hitTestVertexIndices(count: points.count)
		for (index, point) in points.enumerated() {
			try refuseBlockedPointer(at: point, blocked: blocked, windows: windows, axHitTest: hitIndices.contains(index))
		}
	}

	/// Polls up to 200 ms for `pid` to become frontmost (and AX focused when known), so a deferred `activate()`
	/// settles before the blocked-app check; throws `focus_not_acquired` when it never does.
	private func requireTargetFocus(pid: Int32) throws {
		let held = waitForFocus(maxMs: 200, stepMs: 10, holdsFocus: {
			targetHoldsFocus(frontmostPid: NSWorkspace.shared.frontmostApplication?.processIdentifier, focusedPid: systemFocusedPid(), targetPid: pid)
		}, sleepMs: { usleep(UInt32($0) * 1000) }, nowMs: { Int(clamping: DispatchTime.now().uptimeNanoseconds / 1_000_000) })
		if !held { throw BridgeFailure(message: "The target app did not take focus, so keyboard input was not sent", code: "focus_not_acquired") }
	}

	/// Throws `app_blocked` when a pointer event at `point` would reach a blocked app's window or accessibility element.
	private func refuseBlockedPointer(at point: CGPoint, blocked: [String], windows: [[String: Any]]? = nil, axHitTest: Bool = true) throws {
		let windows = windows ?? onScreenWindowList()
		let isBlockedPid: (Int32) -> Bool = { isBlockedBundleId(NSRunningApplication(processIdentifier: $0)?.bundleIdentifier, blocked: blocked) }
		// The window list cannot see through a click-through overlay that sits at layer 0; ask the accessibility hit test too.
		var element: AXUIElement?
		var hitPid: pid_t = 0
		var hit: Int32?
		if axHitTest, AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element) == .success,
			let element, AXUIElementGetPid(element, &hitPid) == .success { hit = hitPid }
		if let pid = coordinateTargetRefusalPid(windows: windows, at: point, hitPid: hit, excludingPid: getpid(), isBlockedPid: isBlockedPid) {
			let app = NSRunningApplication(processIdentifier: pid)
			throw BridgeFailure(message: appBlockedMessage(app?.localizedName ?? "app", app?.bundleIdentifier), code: "app_blocked")
		}
	}


	/// Capture one display, cursor included. Displays are ordered main first, then by x/y origin.
	/// Returned `frame` is in global points (top-left origin), the space `desktopInput` consumes.
	private func captureDisplay(_ request: [String: Any]) throws -> [String: Any] {
		let index = max(0, optionalIntArg(request, "display") ?? 0)
		let maxDimension = optionalIntArg(request, "maxDimension").map { max(1, $0) }
		let blocked = blockedBundleIdList(request)
		let semaphore = DispatchSemaphore(value: 0)
		let result = Box<(CGImage, [[String: Any]], Int)?>(nil)
		let failure = Box<Error?>(nil)
		let task = Task {
			defer { semaphore.signal() }
			do {
				let (shareable, excluded) = try await displayCaptureContent(blocked: blocked, fetch: SCShareableContent.excludingDesktopWindows(_:onScreenWindowsOnly:), applications: \.applications, bundleId: \.bundleIdentifier)
				let mainId = CGMainDisplayID()
				let displays = shareable.displays.sorted { left, right in
					if (left.displayID == mainId) != (right.displayID == mainId) { return left.displayID == mainId }
					return (left.frame.minX, left.frame.minY) < (right.frame.minX, right.frame.minY)
				}
				guard index < displays.count else {
					throw BridgeFailure(message: "Display \(index) does not exist (\(displays.count) available)", code: "display_not_found")
				}
				let display = displays[index]
				let config = SCStreamConfiguration()
				let scale = displayScaleFactor(for: display.frame)
				config.width = max(1, Int((display.frame.width * scale).rounded()))
				config.height = max(1, Int((display.frame.height * scale).rounded()))
				config.showsCursor = true
				// Blocked apps' windows are excluded from the capture itself, so their pixels never leave the helper.
				let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
				let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
				let infos = displays.enumerated().map { offset, item -> [String: Any] in
					["index": offset, "isMain": item.displayID == mainId, "frame": ["x": item.frame.minX, "y": item.frame.minY, "w": item.frame.width, "h": item.frame.height]]
				}
				result.value = (image, infos, index)
			} catch {
				failure.value = error
			}
		}
		if semaphore.wait(timeout: .now() + .seconds(10)) == .timedOut {
			task.cancel()
			throw BridgeFailure(message: "Display capture timed out", code: "capture_timeout")
		}
		if let error = failure.value {
			if let bridge = error as? BridgeFailure { throw bridge }
			throw BridgeFailure(message: "Display capture failed: \(error.localizedDescription)", code: "capture_failed")
		}
		guard let (image, infos, chosen) = result.value, let frameInfo = infos[chosen]["frame"] as? [String: Any] else {
			throw BridgeFailure(message: "Display capture returned no image", code: "capture_failed")
		}
		let output = downscaledImage(image, maxDimension: maxDimension) ?? image
		guard let jpeg = jpegData(image: output, quality: 0.8) else {
			throw BridgeFailure(message: "Failed to encode display image as JPEG", code: "encoding_failed")
		}
		return [
			"display": chosen,
			"displays": infos,
			"frame": frameInfo,
			"image": ["jpegBase64": jpeg.base64EncodedString(), "width": output.width, "height": output.height],
		]
	}

	/// Global-coordinate input. Always physical (HID), like a person at the keys. Points are global points.
	private func desktopInput(_ request: [String: Any]) throws -> [String: Any] {
		let action = try stringArg(request, "action")
		func point(_ key: String = "") throws -> CGPoint {
			let source = key.isEmpty ? request : (request[key] as? [String: Any] ?? [:])
			guard let x = (source["x"] as? NSNumber)?.doubleValue, let y = (source["y"] as? NSNumber)?.doubleValue else {
				throw BridgeFailure(message: "\(action) requires x and y", code: "invalid_args")
			}
			return CGPoint(x: x, y: y)
		}
		let blocked = blockedBundleIdList(request)
		func refuseBlockedWindow(at point: CGPoint) throws {
			try refuseBlockedPointer(at: point, blocked: blocked)
		}
		let keyboard = KeyboardPostCounter(keyboardAdmission(blocked: blocked, deadline: keyboardDeadline(request, now: ProcessInfo.processInfo.systemUptime, ceiling: desktopInputKeyboardCeiling)))
		let refuseBlockedKeyboard = keyboard.beforeKeyDown
		var vertices: [CGPoint] = []
		switch action {
		case "type", "key":
			try refuseBlockedKeyboard(true, false)
		case "moveMouse", "click", "scroll":
			try refuseBlockedWindow(at: try point())
		case "drag":
			vertices = try dragRequestPoints(request["path"])
			// Every vertex, not just the endpoints, is subject to pointer refusal.
			try refuseBlockedPoints(vertices, blocked: blocked)
		default:
			break
		}
		switch action {
		case "activateApp":
			return try activateApp(try stringArg(request, "app"), blocked: blocked)
		case "readClipboard":
			guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty else {
				throw BridgeFailure(message: "The clipboard holds no text", code: "clipboard_empty")
			}
			let limit = 100_000
			return ["performed": action, "text": String(text.prefix(limit)), "truncated": text.count > limit, "length": text.count]
		case "writeClipboard":
			let text = try stringArg(request, "text")
			guard !text.isEmpty else { throw BridgeFailure(message: "writeClipboard requires non-empty text", code: "invalid_args") }
			NSPasteboard.general.clearContents()
			guard NSPasteboard.general.setString(text, forType: .string) else {
				throw BridgeFailure(message: "The clipboard rejected the text", code: "clipboard_write_failed")
			}
			return ["performed": action, "length": text.count]
		default:
			break
		}
		let button = mouseButton(optionalStringArg(request, "button") ?? "left")
		switch action {
		case "moveMouse":
			try postMouseMove(to: try point(), pid: 0)
		case "click":
			let count = max(1, min(3, optionalIntArg(request, "clickCount") ?? 1))
			try postMouseClick(at: try point(), pid: 0, button: button, clickCount: count)
		case "scroll":
			try postScrollWheel(at: try point(), deltaX: optionalIntArg(request, "scrollX") ?? 0, deltaY: optionalIntArg(request, "scrollY") ?? 0, pid: 0)
		case "drag":
			try postMouseDrag(points: vertices, pid: 0)
		case "type":
			let text = try stringArg(request, "text")
			try keyboard.deliver { try postUnicodeText(text, pid: 0, beforeKeyDown: refuseBlockedKeyboard) }
		case "key":
			guard let keys = request["keys"] as? [String], !keys.isEmpty else {
				throw BridgeFailure(message: "keypress requires keys", code: "invalid_args")
			}
			try keyboard.deliver { try postKeyPress(keys: keys, pid: 0, beforeKeyDown: refuseBlockedKeyboard) }
		default:
			throw BridgeFailure(message: "Unknown desktop action '\(action)'", code: "invalid_args")
		}
		// Read back in the same top-left global space the input uses (NSEvent.mouseLocation is bottom-left).
		usleep(30_000)
		let cursor = CGEvent(source: nil)?.location ?? .zero
		return ["performed": action, "mouse": ["x": cursor.x, "y": cursor.y]]
	}

	/// Bring an app (name or bundle id) to the front, launching it when not running. Activation goes
	/// through Launch Services via `/usr/bin/open` (what `open -a` does): `NSRunningApplication.activate`
	/// and AX `AXFrontmost` are refused from a background helper on macOS 14+ (cooperative activation).
	/// It runs as a killable subprocess because an in-process `openApplication` was seen to hang in
	/// the kernel (`_sandbox_extension_issue`) and wedge the daemon's serial Launch Services queue.
	/// Unbundled executables have no bundle URL and get AX + `activate()` only. Fails with
	/// `activation_failed` unless the app is frontmost within 5s.
	private func activateApp(_ query: String, blocked: [String]) throws -> [String: Any] {
		let wanted = query.trimmingCharacters(in: .whitespaces)
		guard !wanted.isEmpty, !wanted.contains("/") else { throw BridgeFailure(message: "activateApp requires an app name or bundle id (no paths)", code: "invalid_args") }
		/// Bundle id beats display name beats executable name; two different apps sharing the winning name is an error.
		func runningApp() throws -> NSRunningApplication? {
			let apps = NSWorkspace.shared.runningApplications
			let tiers: [(NSRunningApplication) -> String?] = [{ $0.bundleIdentifier }, { $0.localizedName }, { $0.executableURL?.lastPathComponent }]
			for key in tiers {
				let matches = apps.filter { key($0)?.caseInsensitiveCompare(wanted) == .orderedSame }
				if Set(matches.map(\.processIdentifier)).count > 1 {
					throw BridgeFailure(message: "'\(wanted)' matches \(matches.count) running apps; use a bundle id", code: "ambiguous_app")
				}
				if let match = matches.first { return match }
			}
			return nil
		}
		let running = try runningApp()
		let home = FileManager.default.homeDirectoryForCurrentUser.path
		let installed = NSWorkspace.shared.urlForApplication(withBundleIdentifier: wanted)
			?? ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/System/Library/CoreServices", "\(home)/Applications"]
				.map { URL(fileURLWithPath: "\($0)/\(wanted).app") }
				.first { FileManager.default.fileExists(atPath: $0.path) }
		guard running != nil || installed != nil else {
			throw BridgeFailure(message: "No running or installed app named '\(wanted)'", code: "app_not_found")
		}
		let resolvedBundleId = running?.bundleIdentifier ?? installed.flatMap { Bundle(url: $0)?.bundleIdentifier }
		if isBlockedBundleId(resolvedBundleId, blocked: blocked) {
			throw BridgeFailure(message: appBlockedMessage(running?.localizedName ?? wanted, resolvedBundleId), code: "app_blocked")
		}
		var app = running
		// Only fall back to an installed bundle when nothing is running: an unbundled process sharing a name with
		// an installed .app must not open the other app.
		if let url = running.map({ $0.bundleURL }) ?? installed {
			let process = Process()
			process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
			process.arguments = [url.path]
			process.standardOutput = FileHandle.nullDevice
			process.standardError = FileHandle.nullDevice
			try process.run()
			let deadline = Date().addingTimeInterval(10)
			while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
			if process.isRunning {
				process.terminate()
				throw BridgeFailure(message: "Launch Services did not open '\(wanted)' within 10s", code: "activation_failed")
			}
			guard process.terminationStatus == 0 else {
				throw BridgeFailure(message: "open exited \(process.terminationStatus) for '\(wanted)'", code: "activation_failed")
			}
			// A fresh launch registers asynchronously; wait for the process to appear.
			let launchDeadline = Date().addingTimeInterval(10)
			while app == nil && Date() < launchDeadline {
				app = NSWorkspace.shared.runningApplications.first { $0.bundleURL?.standardizedFileURL == url.standardizedFileURL } ?? (try? runningApp()) ?? nil
				if app == nil { Thread.sleep(forTimeInterval: 0.1) }
			}
		}
		guard let app else { throw BridgeFailure(message: "No running or installed app named '\(wanted)'", code: "app_not_found") }
		let pid = app.processIdentifier
		let element = AXUIElementCreateApplication(pid)
		let deadline = Date().addingTimeInterval(5)
		var nudged = Date.distantPast
		repeat {
			if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
				return ["performed": "activateApp", "pid": Int(pid), "appName": app.localizedName ?? wanted, "bundleId": app.bundleIdentifier ?? "", "frontmost": true]
			}
			if Date().timeIntervalSince(nudged) > 0.5 {
				nudged = Date()
				AXUIElementSetAttributeValue(element, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
				app.activate()
			}
			usleep(50_000)
		} while Date() < deadline
		throw BridgeFailure(message: "'\(app.localizedName ?? wanted)' did not become frontmost within 5s", code: "activation_failed")
	}

	private func getMousePosition() -> [String: Any] {
		let position = NSEvent.mouseLocation
		return ["x": position.x, "y": position.y]
	}

	private func copyAttribute(_ element: AXUIElement, attribute: CFString) -> AnyObject? {
		var value: AnyObject?
		let status = AXUIElementCopyAttributeValue(element, attribute, &value)
		guard status == .success else { return nil }
		return value
	}

	func boolAttribute(_ element: AXUIElement, attribute: CFString) -> Bool? {
		guard let value = copyAttribute(element, attribute: attribute) else { return nil }
		if let boolValue = value as? Bool {
			return boolValue
		}
		if let number = value as? NSNumber {
			return number.boolValue
		}
		return nil
	}

	private func stringAttribute(_ element: AXUIElement, attribute: CFString) -> String? {
		copyAttribute(element, attribute: attribute) as? String
	}

	// Secure fields can expose plaintext through AX value in non-native apps,
	// and serialized values flow into the model conversation. Never emit them.
	func isSecureTextElement(role: String, subrole: String) -> Bool {
		role == "AXSecureTextField" || subrole == "AXSecureTextField"
	}

	func displayValue(_ element: AXUIElement, role: String, subrole: String) -> String {
		if isSecureTextElement(role: role, subrole: subrole) { return "" }
		return stringAttribute(element, attribute: kAXValueAttribute as CFString) ?? ""
	}

	// kAXSheetsAttribute is unsupported (-25205) on recent macOS; sheets are
	// exposed only as AXSheet-role children. Merge both sources so sheet
	// discovery works across versions.
	func sheetElements(of window: AXUIElement) -> [AXUIElement] {
		sheetInventory(of: window).sheets
	}

	/// Not `complete` when either sheet source or a child's role could not be read: a sheet may be missing.
	func sheetInventory(of window: AXUIElement) -> (sheets: [AXUIElement], complete: Bool) {
		let listed = axElementArrayEvidence(window, attribute: "AXSheets" as CFString)
		let children = axElementArrayEvidence(window, attribute: kAXChildrenAttribute as CFString)
		var complete = listed != nil && children != nil
		var sheets = listed ?? []
		for child in children ?? [] {
			switch stringRead(child, attribute: kAXRoleAttribute as CFString) {
			case .value("AXSheet"):
				if !sheets.contains(where: { CFEqual($0, child) }) { sheets.append(child) }
			case .failed:
				complete = false
			default:
				continue
			}
		}
		return (sheets, complete)
	}

	/// `kAXSizeAttribute` with its evidence, decoded from one reply.
	func sizeRead(_ element: AXUIElement) -> AXSizeRead {
		var value: CFTypeRef?
		switch axReadEvidence(AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &value)) {
		case .failed: return .failed
		case .absent: return .absent
		case .present: return decodeAXSize(value).map(AXSizeRead.size) ?? .absent
		}
	}

	func stringRead(_ element: AXUIElement, attribute: CFString) -> AXStringRead {
		var value: CFTypeRef?
		switch axReadEvidence(AXUIElementCopyAttributeValue(element, attribute, &value)) {
		case .failed: return .failed
		case .absent: return .absent
		case .present: return (value as? String).map(AXStringRead.value) ?? .absent
		}
	}

	/// `nil` for a failed read; an unsupported or valueless attribute is an authoritative `[]`.
	func axElementArrayEvidence(_ element: AXUIElement, attribute: CFString) -> [AXUIElement]? {
		var value: CFTypeRef?
		switch axReadEvidence(AXUIElementCopyAttributeValue(element, attribute, &value)) {
		case .failed: return nil
		case .absent: return []
		case .present:
			if let array = value as? [AXUIElement] { return array }
			return (value as? [AnyObject])?.compactMap(asAXElement) ?? []
		}
	}

	func axElementArray(_ element: AXUIElement, attribute: CFString) -> [AXUIElement] {
		guard let value = copyAttribute(element, attribute: attribute) else { return [] }
		if let array = value as? [AXUIElement] {
			return array
		}
		if let anyArray = value as? [AnyObject] {
			return anyArray.compactMap(asAXElement)
		}
		return []
	}

	func axElementArrayIfPresent(_ element: AXUIElement, attribute: CFString) -> [AXUIElement]? {
		var value: CFTypeRef?
		let status = AXUIElementCopyAttributeValue(element, attribute, &value)
		guard status == .success, let value else { return nil }
		if let array = value as? [AXUIElement] {
			return array
		}
		if let anyArray = value as? [AnyObject] {
			return anyArray.compactMap(asAXElement)
		}
		return []
	}

	func asAXElement(_ value: AnyObject) -> AXUIElement? {
		let cfValue = value as CFTypeRef
		guard CFGetTypeID(cfValue) == AXUIElementGetTypeID() else { return nil }
		return unsafeBitCast(cfValue, to: AXUIElement.self)
	}

	func pointAttribute(_ element: AXUIElement, attribute: CFString) -> CGPoint? {
		decodeAXPoint(copyAttribute(element, attribute: attribute))
	}

	/// A `CGPoint` AX value, or `nil` for any other value.
	func decodeAXPoint(_ value: CFTypeRef?) -> CGPoint? {
		guard let cfValue = value, CFGetTypeID(cfValue) == AXValueGetTypeID() else { return nil }
		let axValue = unsafeBitCast(cfValue, to: AXValue.self)
		guard AXValueGetType(axValue) == .cgPoint else { return nil }
		var point = CGPoint.zero
		guard AXValueGetValue(axValue, .cgPoint, &point) else { return nil }
		return point
	}

	/// `kAXPositionAttribute` decoded from one reply: `nil` for a failed read, `.zero` for an absent or undecodable one.
	private func positionRead(_ element: AXUIElement) -> CGPoint? {
		var value: CFTypeRef?
		switch axReadEvidence(AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &value)) {
		case .failed: return nil
		case .absent: return .zero
		case .present: return decodeAXPoint(value) ?? .zero
		}
	}

	/// `frameForWindow` with evidence: `read` is false when the position or size read failed (read as `.zero`).
	private func frameRead(_ window: AXUIElement) -> (frame: CGRect, read: Bool) {
		let origin = positionRead(window)
		var size = CGSize.zero
		let sized = sizeRead(window)
		if case .size(let value) = sized { size = value }
		return (CGRect(origin: origin ?? .zero, size: size), origin != nil && sized != .failed)
	}

	func sizeAttribute(_ element: AXUIElement, attribute: CFString) -> CGSize? {
		decodeAXSize(copyAttribute(element, attribute: attribute))
	}

	/// A `CGSize` AX value, or `nil` for any other value.
	func decodeAXSize(_ value: CFTypeRef?) -> CGSize? {
		guard let cfValue = value, CFGetTypeID(cfValue) == AXValueGetTypeID() else { return nil }
		let axValue = unsafeBitCast(cfValue, to: AXValue.self)
		guard AXValueGetType(axValue) == .cgSize else { return nil }
		var size = CGSize.zero
		guard AXValueGetValue(axValue, .cgSize, &size) else { return nil }
		return size
	}

	private func frameForWindow(_ window: AXUIElement) -> CGRect {
		let origin = pointAttribute(window, attribute: kAXPositionAttribute as CFString) ?? .zero
		let size = sizeAttribute(window, attribute: kAXSizeAttribute as CFString) ?? .zero
		return CGRect(origin: origin, size: size)
	}

	private func allCGWindowEntries() -> [[String: Any]] {
		(CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
	}

	func cgWindowOwners(entries suppliedEntries: [[String: Any]]? = nil) -> [CGWindowOwnerSummary] {
		let entries = suppliedEntries ?? allCGWindowEntries()
		var seen = Set<Int32>()
		var owners: [CGWindowOwnerSummary] = []
		for entry in entries {
			guard let ownerPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { continue }
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
			if layer != 0 || seen.contains(ownerPid) { continue }
			guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
				let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
				bounds.width >= 100,
				bounds.height >= 80
			else {
				continue
			}
			let ownerName = (entry[kCGWindowOwnerName as String] as? String) ?? processName(pid: ownerPid) ?? "Unknown App"
			seen.insert(ownerPid)
			owners.append(CGWindowOwnerSummary(pid: ownerPid, name: ownerName))
		}
		return owners
	}

	private func pidForWindowId(_ windowId: UInt32) -> Int32? {
		windowInfo(windowId: windowId)?.pid
	}

	func cgWindowCandidates(pid: Int32, entries suppliedEntries: [[String: Any]]? = nil) -> [CGWindowCandidate] {
		let entries = suppliedEntries ?? allCGWindowEntries()
		var candidates: [CGWindowCandidate] = []
		for (zOrder, entry) in entries.enumerated() {
			guard let ownerPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
				ownerPid == pid
			else {
				continue
			}
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
			if layer != 0 { continue }

			guard let windowNumber = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value else {
				continue
			}
			guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
				let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
			else {
				continue
			}

			let title = (entry[kCGWindowName as String] as? String) ?? ""
			let isOnscreen = (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? true
			candidates.append(
				CGWindowCandidate(
					windowId: windowNumber,
					title: title,
					bounds: bounds,
					isOnscreen: isOnscreen,
					layer: layer,
					zOrder: zOrder
				)
			)
			if candidates.count == 128 { break }
		}
		return candidates
	}

	func cgBroadRootOwners(entries: [[String: Any]]) -> [CGWindowOwnerSummary] {
		let popupLevel = Int(CGWindowLevelForKey(.popUpMenuWindow))
		var seen = Set<Int32>()
		return entries.compactMap { entry -> CGWindowOwnerSummary? in
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
			guard layer == 0 || layer == popupLevel,
				let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
			else { return nil }
			if layer == popupLevel {
				guard (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true else { return nil }
			} else {
				guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
					let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
					bounds.width >= 100,
					bounds.height >= 80
				else { return nil }
			}
			guard seen.insert(pid).inserted else { return nil }
			let name = (entry[kCGWindowOwnerName as String] as? String) ?? processName(pid: pid) ?? "Unknown App"
			return CGWindowOwnerSummary(pid: pid, name: name)
		}
	}

	func cgPopupMenuCandidates(pid: Int32?, entries: [[String: Any]]) -> [CGWindowCandidate] {
		let popupLevel = Int(CGWindowLevelForKey(.popUpMenuWindow))
		var candidates: [CGWindowCandidate] = []
		for (zOrder, entry) in entries.enumerated() {
			guard let ownerPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { continue }
			if let pid, ownerPid != pid { continue }
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
			if layer != popupLevel { continue }
			guard let windowNumber = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
				let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
				let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
			else { continue }
			let title = (entry[kCGWindowName as String] as? String) ?? ""
			let isOnscreen = (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
			guard isOnscreen else { continue }
			candidates.append(CGWindowCandidate(windowId: windowNumber, title: title, bounds: bounds, isOnscreen: isOnscreen, layer: layer, zOrder: zOrder))
			if candidates.count == 128 { break }
		}
		return candidates
	}

	private func openMenuElements(pid: Int32, messagingTimeout: Float = 1.0) -> [AXUIElement] {
		let app = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(app, messagingTimeout)
		let descendants = collectDescendants(startingAt: app, maxDepth: 6)
		var menus = descendants.filter { (stringAttribute($0, attribute: kAXRoleAttribute as CFString) ?? "") == "AXMenu" }
		if menus.isEmpty,
			let focused = copyAttribute(app, attribute: kAXFocusedUIElementAttribute as CFString).flatMap(asAXElement)
		{
			var current: AXUIElement? = focused
			while let element = current {
				if (stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? "") == "AXMenu" {
					menus.append(element)
					break
				}
				current = copyAttribute(element, attribute: kAXParentAttribute as CFString).flatMap(asAXElement)
			}
		}
		return menus
	}

	private func pairingForWindow(_ window: AXUIElement, pid: Int32) -> WindowPairing {
		windowPairings(windows: [window], candidates: cgWindowCandidates(pid: pid))[ObjectIdentifier(window)] ?? WindowPairing(candidate: nil, score: -Double.greatestFiniteMagnitude, confidence: "low")
	}

	/// `pairWindows` over live AX reads.
	func windowPairings(windows: [AXUIElement], candidates: [CGWindowCandidate]) -> [ObjectIdentifier: WindowPairing] {
		pairWindows(windows, candidates: candidates, read: pairingRead)
	}

	/// The title and frame one CG pairing scores, each from one read.
	private func pairingRead(_ window: AXUIElement) -> WindowPairingRead {
		let (frame, read) = frameRead(window)
		return WindowPairingRead(title: stringRead(window, attribute: kAXTitleAttribute as CFString), frame: frame, frameRead: read)
	}

	private func displayScaleFactor(for frame: CGRect) -> Double {
		var displayCount: UInt32 = 0
		guard CGGetOnlineDisplayList(0, nil, &displayCount) == .success, displayCount > 0 else {
			return Double(NSScreen.main?.backingScaleFactor ?? 1.0)
		}

		var displays = Array(repeating: CGDirectDisplayID(), count: Int(displayCount))
		guard CGGetOnlineDisplayList(displayCount, &displays, &displayCount) == .success else {
			return Double(NSScreen.main?.backingScaleFactor ?? 1.0)
		}

		var chosenDisplay: CGDirectDisplayID?
		var chosenArea: CGFloat = -1
		for display in displays {
			let bounds = CGDisplayBounds(display)
			let overlap = bounds.intersection(frame)
			let area = overlap.isNull ? 0 : overlap.width * overlap.height
			if area > chosenArea {
				chosenArea = area
				chosenDisplay = display
			}
		}

		guard let display = chosenDisplay, let mode = CGDisplayCopyDisplayMode(display) else {
			return Double(NSScreen.main?.backingScaleFactor ?? 1.0)
		}

		let width = Double(mode.width)
		guard width > 0 else { return 1.0 }
		let scale = Double(mode.pixelWidth) / width
		return scale > 0 ? scale : 1.0
	}

	private func captureWindow(windowId: UInt32) throws -> CapturedWindowImage {
		if #available(macOS 14.0, *) {
			let semaphore = DispatchSemaphore(value: 0)
			let capturedImage = Box<CGImage?>(nil)
			let capturedError = Box<Error?>(nil)

			let task = Task {
				defer { semaphore.signal() }
				do {
					if Task.isCancelled {
						return
					}
					let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
					guard let window = shareable.windows.first(where: { $0.windowID == windowId }) else {
						throw BridgeFailure(message: "Window \(windowId) is not available for capture", code: "window_not_found")
					}

					let filter = SCContentFilter(desktopIndependentWindow: window)
					let config = SCStreamConfiguration()
					// Avoid ScreenCaptureKit's default 1920x1080 canvas for window captures.
					let scale = displayScaleFactor(for: window.frame)
					config.width = max(1, Int((window.frame.width * scale).rounded()))
					config.height = max(1, Int((window.frame.height * scale).rounded()))
					config.showsCursor = false
					config.ignoreShadowsSingleWindow = true

					let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
					capturedImage.value = image
				} catch {
					capturedError.value = error
				}
			}

			if semaphore.wait(timeout: .now() + .seconds(8)) == .timedOut {
				task.cancel()
				if let payload = try cgWindowScreenshotFallback(windowId: windowId) {
					return payload
				}
				throw BridgeFailure(message: "Capture timed out while capturing window \(windowId)", code: "capture_timeout")
			}

			if let error = capturedError.value {
				if let payload = try cgWindowScreenshotFallback(windowId: windowId) {
					return payload
				}
				if let failure = error as? BridgeFailure {
					throw failure
				}
				throw BridgeFailure(message: "Capture failed: \(error.localizedDescription)", code: "capture_failed")
			}

			guard let image = capturedImage.value else {
				if let payload = try cgWindowScreenshotFallback(windowId: windowId) {
					return payload
				}
				throw BridgeFailure(message: "Capture failed", code: "capture_failed")
			}

			return CapturedWindowImage(image: image, windowId: windowId, frame: currentWindowBounds(windowId: windowId) ?? CGRect(x: 0, y: 0, width: image.width, height: image.height))
		}
		if let payload = try cgWindowScreenshotFallback(windowId: windowId) {
			return payload
		}
		throw BridgeFailure(message: "Capture failed", code: "capture_failed")
	}

	func jpegData(image: CGImage, quality: Double) -> Data? {
		let data = NSMutableData()
		guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { return nil }
		CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
		guard CGImageDestinationFinalize(destination) else { return nil }
		return data as Data
	}

	func downscaledImage(_ image: CGImage, maxDimension: Int?) -> CGImage? {
		guard let maxDimension, max(image.width, image.height) > maxDimension else { return nil }
		let scale = Double(maxDimension) / Double(max(image.width, image.height))
		let width = max(1, Int(Double(image.width) * scale))
		let height = max(1, Int(Double(image.height) * scale))
		guard let context = CGContext(
			data: nil,
			width: width,
			height: height,
			bitsPerComponent: image.bitsPerComponent,
			bytesPerRow: 0,
			space: image.colorSpace ?? CGColorSpaceCreateDeviceRGB(),
			bitmapInfo: image.bitmapInfo.rawValue
		) else { return nil }
		context.interpolationQuality = .medium
		context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
		return context.makeImage()
	}

	private func cgWindowScreenshotFallback(windowId: UInt32) throws -> CapturedWindowImage? {
		if let payload = try systemScreenshotWindow(windowId: windowId) {
			return payload
		}
		return nil
	}

	private func systemScreenshotWindow(windowId: UInt32) throws -> CapturedWindowImage? {
		let tempUrl = FileManager.default.temporaryDirectory.appendingPathComponent("pi-cu-\(UUID().uuidString).png")
		defer { try? FileManager.default.removeItem(at: tempUrl) }
		// Owner-only perms in case TMPDIR ever resolves to a shared directory.
		FileManager.default.createFile(atPath: tempUrl.path, contents: nil, attributes: [.posixPermissions: 0o600])

		let process = Process()
		process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
		process.arguments = ["-x", "-l", String(windowId), tempUrl.path]
		try process.run()
		let deadline = Date().addingTimeInterval(5)
		while process.isRunning && Date() < deadline {
			Thread.sleep(forTimeInterval: 0.05)
		}
		if process.isRunning {
			process.terminate()
			Thread.sleep(forTimeInterval: 0.1)
			if process.isRunning { process.interrupt() }
			return nil
		}
		guard process.terminationStatus == 0 else { return nil }
		guard let data = try? Data(contentsOf: tempUrl), !data.isEmpty else { return nil }
		guard let imageRep = NSBitmapImageRep(data: data), let cgImage = imageRep.cgImage else { return nil }
		return CapturedWindowImage(image: cgImage, windowId: windowId, frame: currentWindowBounds(windowId: windowId) ?? CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
	}

	private func currentWindowBounds(windowId: UInt32) -> CGRect? {
		if #available(macOS 14.0, *), let scBounds = currentWindowBoundsViaScreenCaptureKit(windowId: windowId) {
			return scBounds
		}
		return windowInfo(windowId: windowId)?.bounds
	}

	private func windowInfo(windowId: UInt32) -> (pid: Int32, bounds: CGRect)? {
		func matchingEntry(_ entries: [[String: Any]]?) -> [String: Any]? {
			entries?.first {
				($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowId
			}
		}

		let requestedIds = [NSNumber(value: windowId)] as CFArray
		let targetedEntries = CGWindowListCreateDescriptionFromArray(requestedIds) as? [[String: Any]]
		let entry = matchingEntry(targetedEntries) ?? matchingEntry(
			CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]
		)
		guard let entry,
			let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
			let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
			let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
		else {
			return nil
		}
		return (pid, bounds)
	}

	@available(macOS 14.0, *)
	private func currentWindowBoundsViaScreenCaptureKit(windowId: UInt32) -> CGRect? {
		let semaphore = DispatchSemaphore(value: 0)
		let output = Box<CGRect?>(nil)

		let task = Task {
			defer { semaphore.signal() }
			do {
				if Task.isCancelled {
					return
				}
				let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
				if let window = shareable.windows.first(where: { $0.windowID == windowId }) {
					output.value = window.frame
				}
			} catch {
				output.value = nil
			}
		}

		if semaphore.wait(timeout: .now() + .seconds(2)) == .timedOut {
			task.cancel()
			return nil
		}
		return output.value
	}

	/// Stamps at post time from a monotonic clock: a drag's release is allocated before its mouse-down, so its
	/// creation time would precede the down and the drag steps.
	private func postPointerEvent(_ event: CGEvent, pid: Int32, delivery: String) {
		if delivery == "hid" { _ = inputSink.prepareHID(pid) }
		event.timestamp = inputSink.eventTimestamp()
		postEvent(event, pid: pid, delivery: delivery)
	}

	private func postEvent(_ event: CGEvent, pid: Int32, delivery: String = "hid") {
		if delivery == "pid" {
			inputSink.postToPid(event, pid)
		} else {
			inputSink.postHID(event, pid)
		}
	}

	private func postMouseMove(to point: CGPoint, pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		guard let move = inputSink.mouseEvent(.mouseMoved, point, .left) else {
			throw BridgeFailure(message: "Failed to create mouse move event", code: "input_failed")
		}
		postPointerEvent(move, pid: pid, delivery: delivery)
	}

	private func mouseButton(_ name: String) -> CGMouseButton {
		switch name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
		case "right":
			return .right
		case "middle", "center":
			return .center
		default:
			return .left
		}
	}

	private func mouseDownType(for button: CGMouseButton) -> CGEventType {
		switch button {
		case .right:
			return .rightMouseDown
		case .center:
			return .otherMouseDown
		default:
			return .leftMouseDown
		}
	}

	private func mouseUpType(for button: CGMouseButton) -> CGEventType {
		switch button {
		case .right:
			return .rightMouseUp
		case .center:
			return .otherMouseUp
		default:
			return .leftMouseUp
		}
	}

	private func mouseDraggedType(for button: CGMouseButton) -> CGEventType {
		switch button {
		case .right:
			return .rightMouseDragged
		case .center:
			return .otherMouseDragged
		default:
			return .leftMouseDragged
		}
	}

	private func postMouseClick(at point: CGPoint, pid: Int32, button: CGMouseButton = .left, clickCount: Int = 1, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		try postMouseMove(to: point, pid: pid, delivery: delivery)
		for index in 1...max(1, clickCount) {
			guard let down = inputSink.mouseEvent(mouseDownType(for: button), point, button),
				let up = inputSink.mouseEvent(mouseUpType(for: button), point, button)
			else {
				throw BridgeFailure(message: "Failed to create mouse click event", code: "input_failed")
			}
			down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
			up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
			postPointerEvent(down, pid: pid, delivery: delivery)
			inputSink.sleep(12_000)
			postPointerEvent(up, pid: pid, delivery: delivery)
			if index < clickCount {
				inputSink.sleep(70_000)
			}
		}
	}

	private func postMouseDrag(points: [CGPoint], pid: Int32, delivery: String = "hid") throws {
		let maxStep = try admittedDragStep(points)
		guard let first = points.first, let last = points.last else {
			throw BridgeFailure(message: "Drag requires at least two points", code: "invalid_args")
		}
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		try inputSink.checkDragCancellation()
		// Reserve the matching release before sending any input. Unwinding must not allocate it.
		guard let up = inputSink.mouseEvent(.leftMouseUp, first, .left) else {
			throw BridgeFailure(message: "Failed to create mouse up event", code: "input_failed")
		}
		try postMouseMove(to: first, pid: pid, delivery: delivery)
		guard let down = inputSink.mouseEvent(.leftMouseDown, first, .left) else {
			throw BridgeFailure(message: "Failed to create mouse down event", code: "input_failed")
		}
		down.setIntegerValueField(.mouseEventClickState, value: 1)
		postPointerEvent(down, pid: pid, delivery: delivery)
		var releasePosition = first
		defer {
			up.location = releasePosition
			up.setIntegerValueField(.mouseEventClickState, value: 1)
			postPointerEvent(up, pid: pid, delivery: delivery)
		}
		inputSink.sleep(30_000)

		var previous = first
		for point in points.dropFirst() {
			for step in interpolatedDragPoints(from: previous, to: point, maxStep: maxStep) {
				try inputSink.checkDragCancellation()
				guard let drag = inputSink.mouseEvent(mouseDraggedType(for: .left), step, .left) else {
					throw BridgeFailure(message: "Failed to create mouse drag event", code: "input_failed")
				}
				drag.setIntegerValueField(.mouseEventClickState, value: 1)
				postPointerEvent(drag, pid: pid, delivery: delivery)
				releasePosition = step
				inputSink.sleep(8_000)
			}
			previous = point
		}
		releasePosition = last
	}

	private func postScrollWheel(at point: CGPoint, deltaX: Int, deltaY: Int, pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		try postMouseMove(to: point, pid: pid, delivery: delivery)
		let counts = scrollWheelCounts(deltaX: deltaX, deltaY: deltaY)
		guard let event = inputSink.wheelEvent(counts.wheel1, counts.wheel2) else {
			throw BridgeFailure(message: "Failed to create scroll event", code: "input_failed")
		}
		event.location = point
		postPointerEvent(event, pid: pid, delivery: delivery)
	}

	private func modifierFlag(_ key: String) -> CGEventFlags? {
		switch key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
		case "cmd", "command", "meta":
			return .maskCommand
		case "ctrl", "control":
			return .maskControl
		case "shift":
			return .maskShift
		case "option", "alt":
			return .maskAlternate
		default:
			return nil
		}
	}

	private func keyCode(_ key: String) -> CGKeyCode? {
		let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let table: [String: CGKeyCode] = [
			"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
			"q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
			"6": 22, "5": 23, "=": 24, "+": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
			"]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "enter": 36,
			"l": 37, "j": 38, "'": 39, "\"": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
			"n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, " ": 49, "`": 50, "~": 50,
			"backspace": 51, "delete": 51, "del": 51, "esc": 53, "escape": 53,
			"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
			"f9": 101, "f10": 109, "f11": 103, "f12": 111,
			"home": 115, "pageup": 116, "page_up": 116, "page down": 121, "pagedown": 121, "page_down": 121,
			"forwarddelete": 117, "forward_delete": 117, "end": 119,
			"left": 123, "arrowleft": 123, "arrow_left": 123,
			"right": 124, "arrowright": 124, "arrow_right": 124,
			"down": 125, "arrowdown": 125, "arrow_down": 125,
			"up": 126, "arrowup": 126, "arrow_up": 126,
		]
		return table[normalized]
	}

	private func keyChord(_ keys: [String]) -> (flags: CGEventFlags, key: String)? {
		guard keys.count >= 2 else { return nil }
		var flags = CGEventFlags()
		for key in keys.dropLast() {
			guard let flag = modifierFlag(key) else {
				return nil
			}
			flags.insert(flag)
		}
		return (flags, keys.last ?? "")
	}

	/// One stroke of a keypress: a key code with its modifiers, or a single character typed as text.
	private enum KeyStroke {
		case code(CGKeyCode, CGEventFlags)
		case character(String)
	}

	/// Resolves every stroke of `keys` before any is posted, so an unsupported key refuses the whole sequence with
	/// nothing posted. The message names the key's position, never the key.
	private func keyStrokes(_ keys: [String]) throws -> [KeyStroke] {
		func stroke(_ key: String, flags: CGEventFlags, index: Int) throws -> KeyStroke {
			if let code = keyCode(key) { return .code(code, flags) }
			if key.count == 1 { return .character(key) }
			throw BridgeFailure(message: "Unsupported key at keys[\(index)]; no key was posted", code: "invalid_args")
		}
		if let chord = keyChord(keys) { return [try stroke(chord.key, flags: chord.flags, index: keys.count - 1)] }
		return try keys.enumerated().map { index, key in
			let parts = key
				.split(separator: "+")
				.map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
				.filter { !$0.isEmpty }
			if let chord = keyChord(parts) { return try stroke(chord.key, flags: chord.flags, index: index) }
			return try stroke(key, flags: [], index: index)
		}
	}

	private func postKeyPress(keys: [String], pid: Int32, delivery: String = "hid", beforeKeyDown: BeforeKeyDown) throws {
		let strokes = try keyStrokes(keys)
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		for stroke in strokes {
			switch stroke {
			case let .code(code, flags):
				try postKeyCode(code, flags: flags, pid: pid, delivery: delivery, beforeKeyDown: beforeKeyDown)
			case let .character(character):
				try postUnicodeText(character, pid: pid, delivery: delivery, beforeKeyDown: beforeKeyDown)
			}
		}
	}

	private func postKeyCode(_ code: CGKeyCode, flags: CGEventFlags, pid: Int32, delivery: String, beforeKeyDown: BeforeKeyDown) throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		guard let down = inputSink.keyEvent(code, true), let up = inputSink.keyEvent(code, false)
		else {
			throw BridgeFailure(message: "Failed to create key event", code: "input_failed")
		}
		down.flags = flags
		up.flags = flags
		try postKeyPair(down, up, pid: pid, delivery: delivery, beforeKeyDown: beforeKeyDown)
	}

	private func postUnicodeText(_ text: String, pid: Int32, delivery: String = "hid", beforeKeyDown: BeforeKeyDown) throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		let inputSource = inputSink.keyboardInputSource()
		try beforeKeyDown(true, false)
		for scalar in text.unicodeScalars {
			let char = String(scalar)
			if let stroke = physicalKeyStroke(for: char, inputSource: inputSource) {
				try postKeyCode(stroke.code, flags: stroke.flags, pid: pid, delivery: delivery, beforeKeyDown: beforeKeyDown)
				continue
			}
			guard let down = inputSink.keyEvent(0, true), let up = inputSink.keyEvent(0, false)
			else {
				throw BridgeFailure(message: "Failed to create unicode key event", code: "input_failed")
			}
			setUnicodeString(event: down, text: char)
			setUnicodeString(event: up, text: char)
			try postKeyPair(down, up, pid: pid, delivery: delivery, beforeKeyDown: beforeKeyDown)
		}
	}

	private func postAtomicUnicodeText(_ text: String, pid: Int32, delivery: String, beforeKeyDown: BeforeKeyDown) throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		guard let down = inputSink.keyEvent(0, true), let up = inputSink.keyEvent(0, false)
		else { throw BridgeFailure(message: "Failed to create unicode text event", code: "input_failed") }
		setUnicodeString(event: down, text: text)
		setUnicodeString(event: up, text: text)
		try postKeyPair(down, up, pid: pid, delivery: delivery, hold: true, beforeKeyDown: beforeKeyDown)
	}

	private func postKeyPair(_ down: CGEvent, _ up: CGEvent, pid: Int32, delivery: String, hold: Bool = false, beforeKeyDown: BeforeKeyDown) throws {
		let prepared = delivery == "hid" && inputSink.prepareHID(pid)
		try beforeKeyDown(prepared, true)
		postEvent(down, pid: pid, delivery: delivery)
		// Release directly, without another activation or refusal.
		if hold { inputSink.sleep(8_000) }
		postEvent(up, pid: pid, delivery: delivery)
		if !hold { inputSink.sleep(8_000) }
	}

	/// Prefer physical key codes for characters represented by the US layout.
	/// AppKit field editors can observe synthetic Unicode events without applying
	/// them to the backing value, while normal key codes follow the same input
	/// path as a user keystroke. Unicode synthesis remains the fallback for text
	/// that has no direct key representation, and for any character the active
	/// layout or input method would not type from that US key.
	private func physicalKeyStroke(for character: String, inputSource: KeyboardInputSource) -> (code: CGKeyCode, flags: CGEventFlags)? {
		guard let stroke = usLayoutKeyStroke(for: character), let code = keyCode(stroke.key) else { return nil }
		let produced = inputSource.layoutData.flatMap { keyboardLayoutCharacter(layoutData: $0, keyCode: code, shift: stroke.shift) }
		guard physicalKeyStrokeTypes(character, isKeyboardLayout: inputSource.isKeyboardLayout, layoutProduces: produced) else { return nil }
		return (code, stroke.shift ? [.maskShift] : [])
	}

	private func setUnicodeString(event: CGEvent, text: String) {
		var utf16 = Array(text.utf16)
		utf16.withUnsafeMutableBufferPointer { buffer in
			guard let base = buffer.baseAddress else { return }
			event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
		}
	}

}


/*
PI_DOCS_REFERENCE_BEGIN reference/platforms/macos/accessibility

This page is the direct reference for macOS Accessibility, usually abbreviated AX. The implementation lives primarily in [`native/macos/bridge.swift`](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift); the TypeScript platform adapter lives in [`src/platform/macos/`](https://github.com/injaneity/pi-computer-use/tree/main/src/platform/macos).

## Trust and permission

The helper checks trust with [`AXIsProcessTrusted()`](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted) and requests it with [`AXIsProcessTrustedWithOptions(_:)`](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions). Accessibility permission enables semantic UI observation and AX actions; it does not grant window image capture.

The grant must apply to the resolved helper app during normal operation. The helper is installed per user at `~/Applications/pi-computer-use.app` by default; existing writable system-wide installs remain at `/Applications/pi-computer-use.app`, and `PI_COMPUTER_USE_HELPER_APP_PATH` selects an explicit location for development or testing. Setup requests trust before opening System Settings and restarts the helper after recheck. Pane names and listing behavior vary by macOS release, so they are not part of the runtime contract.

## AX root discovery

Root discovery combines several APIs rather than treating AX as a window registry:

1. [`NSWorkspace.runningApplications`](https://developer.apple.com/documentation/appkit/nsworkspace/runningapplications) supplies process identity and frontmost state.
2. [`AXUIElementCreateApplication`](https://developer.apple.com/documentation/applicationservices/axuielement) creates an application-level AX element for each candidate process.
3. AX window attributes provide controllable windows, roles, frames, state, and child trees. When an app reports an empty `AXWindows` list, the helper falls back to its `AXMainWindow` and `AXFocusedWindow`.
4. Core Graphics window data is paired separately to provide capture IDs and visual ordering.

Windows, sheets, dialogs, popovers, and open menus can become roots. Menus use the `AXMenu` role when an AX element is available. A visually discovered menu without a matching AX element is returned as `pictureOnly`, so it cannot receive ref-targeted AX actions. An AX root without a matching Core Graphics window is unpaired; the [root targeting reference](./root-targeting.mdx) defines how such roots are addressed and observed.

## Tree extraction

An observation walks the selected AX subtree breadth-first. It reads available roles, subroles, identifiers, titles, descriptions, values, frames, focus state, supported actions, and settable attributes. The native walk stops at 2,000 nodes, 20 seconds after the root node was built, or 25 seconds after the look started (the client gives up at 33), whichever comes first; incomplete ancestors, and nodes whose children could not be read, are marked `truncated` rather than presented as complete.

The resulting outline preserves native semantics where they are available. It does not infer that every visible control has an AX node. Web views, custom drawing, games, and apps with incomplete accessibility implementations can expose sparse trees.

## Semantic operations

The helper prefers AX operations before synthesized input:

- press and eligible click actions call [`AXUIElementPerformAction`](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction) with `AXPress`;
- `setText` writes `AXValue` through [`AXUIElementSetAttributeValue`](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue) and reads the value back; on the non-web path an accepted `AXValue` write that the readback does not confirm is `unknown`, and the bridge does not automatically resend it (a later explicit action may still write the field); a write refused on the cached and the refound handle is `didnt` with `ax_write_failed` and the `AXError`, with no coordinate fallback, input lock, activation or hit test;
- semantic scrolling walks the target and its ancestors for supported AX scroll actions;
- foreground coordinate delivery uses `AXUIElementCopyElementAtPosition` as an occlusion preflight.

An advertised AX action is a delivery capability, not proof of an application-level result. Action outcomes remain `worked`, `didnt`, or `unknown` based on read-back or observable state evidence.

## Strict headless behavior

`headless: true` maps native actions to the `ax_only` policy. AX press, `AXValue` writes outside web content, and semantic scrolling still run. Actions that would fall back to synthesized pointer input, every `typeText` and `keypress`, and web text replacement fail with `foreground_required` before the helper posts events or activates the target. The agent cursor overlay and activity glow are not shown.

## Common interpretation rules

- An empty outline usually indicates missing Accessibility trust, an inaccessible target, or an app that exposes no useful AX hierarchy.
- `truncated` means the bounded walk did not retrieve the complete descendant tree.
- `pictureOnly` means the element came from visual evidence and cannot be targeted by AX ref.
- A supported action describes what the element reports, not whether the app will honor it.
- AX frames and Core Graphics windows are paired heuristically; low-confidence pairing must not be treated as exact identity.

For the image side of an observation, continue to [Capture and OCR](./capture.mdx). For fallback delivery and checked outcomes, continue to [Actions and input delivery](./actions.mdx). The [complete implementation reference](./implementation.mdx) contains line-level source citations and current limits.
PI_DOCS_REFERENCE_END
*/

/*
PI_DOCS_REFERENCE_BEGIN reference/platforms/macos/capture

macOS image evidence is separate from Accessibility. A target can have a complete AX outline while capture fails, or a valid image while its AX tree is sparse.

## Screen Recording permission

The helper preflights Screen Recording with [`CGPreflightScreenCaptureAccess()`](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess%28%29) and requests it with [`CGRequestScreenCaptureAccess()`](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess%28%29). It additionally requires a nonempty [`SCShareableContent`](https://developer.apple.com/documentation/screencapturekit/scshareablecontent) query before reporting capture readiness.

That content query is a project readiness check, not an Apple-defined permission-status API. Passing it does not guarantee that every later window capture will succeed.

## Window identity and pairing

[`CGWindowListCopyWindowInfo`](https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo%28_%3A_%3A%29) supplies window IDs, owner PIDs, bounds, layers, titles, onscreen state, and ordering candidates. AX windows do not expose the same project-owned identifier, so the helper pairs AX and Core Graphics windows using title, geometry, onscreen state, and one-to-one assignment.

Pairing metadata reports `exact`, `high`, or `low` confidence. A low-confidence match is useful evidence but is not guaranteed identity. A root with no matching Core Graphics window is unpaired and has no `windowId`.

## ScreenCaptureKit path

For a requested image, the helper:

1. retrieves the matching `SCWindow` from `SCShareableContent`;
2. creates an `SCContentFilter` for that desktop-independent window;
3. disables cursor rendering and ignores single-window shadows;
4. captures one frame with [`SCScreenshotManager.captureImage`](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager/captureimage%28contentfilter%3Aconfiguration%3Acompletionhandler%3A%29).

`SCScreenshotManager` requires macOS 14, which is why the helper's deployment target is macOS 14 or newer.

Visual observation of an unpaired root fails with `root_not_capturable`; use semantic observation (`image: never`). No other window is captured in its place.

## Fallback capture

If ScreenCaptureKit times out or fails, the helper invokes `/usr/sbin/screencapture -x -l <window-id>` and reads an owner-only temporary PNG. This is a fallback implementation detail, not a guarantee that capture will work after a ScreenCaptureKit failure.

## OCR and picture-only nodes

Forced visual observation runs Vision's accurate [`VNRecognizeTextRequest`](https://developer.apple.com/documentation/vision/vnrecognizetextrequest), with language correction disabled. Nonduplicate recognized text boxes are attached to the outline.

OCR-derived nodes are marked `pictureOnly`. They can provide text and geometry evidence, but ref-targeted Accessibility actions are blocked because no corresponding AX element exists. A coordinate action can use visual evidence only when the saved observation includes the required image geometry.

## Failure boundaries

- A successful permission readiness check does not guarantee capture of every window.
- Protected, remote, transient, or rapidly closing surfaces may not produce an image.
- AX-to-Core-Graphics pairing can be uncertain, and unpaired roots are never capturable.
- OCR recognizes pixels, not control semantics.
- Outline-only menu roots cannot be coordinate targets without image geometry.

For semantic UI structure, use [Accessibility and AX](./accessibility.mdx). For coordinate delivery and outcome evidence, use [Actions and input delivery](./actions.mdx).
PI_DOCS_REFERENCE_END
*/

/*
PI_DOCS_REFERENCE_BEGIN reference/platforms/macos/actions

Action delivery is divided between model-level coordination in [`src/bridge.ts`](https://github.com/injaneity/pi-computer-use/blob/main/src/bridge.ts) and native grounding, delivery, and verification in [`native/macos/bridge.swift`](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift).

## Delivery order

Ref-based actions prefer the least disruptive credible strategy:

1. use a supported semantic AX operation;
2. use background event delivery when semantic delivery is unavailable and policy permits it;
3. request foreground delivery only when the action requires focus or a checked background attempt proves it had no effect.

Coordinate clicks and focus-dependent steps can begin in the foreground. Ambiguous pointer outcomes are not replayed because repeating an uncertain click can duplicate a side effect.

Actions and the successor capture stay on the root the state belongs to; `act_ui` does not redirect to a foreground modal. A modal that appears afterwards is reported in `rootDelta` as `appeared`.

## AX delivery

Eligible presses use `AXPress`. A failed press is re-pressed on a refreshed element, or falls back to a pointer click, only after an error that proves it was not delivered (a dead element, or an action the element, API or app refused); `cannotComplete`, `failure` and any other error return `unknown` with `error.code` `ax_delivery_unknown` and `evidence.deliveryUnknown`, are never delivered again, and stop the transaction. Non-web text replacement writes `AXValue`; an accepted write is `worked` only when the readback matches, otherwise `unknown` with `evidence.deliveryUnknown`, not automatically resent in the foreground, and it stops the transaction (#1290). Web text replacement posts `cmd+a` (unless the selection write took) and the text; a readback that does not confirm the text is likewise `unknown` with `evidence.deliveryUnknown`, never `didnt` (#1281). Semantic scrolling searches the target and ancestor chain for AX scroll actions. These paths are described in [Accessibility and AX](./accessibility.mdx).

`secondaryAction` runs one named AX action (e.g. `AXShowMenu`) that the element currently advertises; the bridge validates the name against the `inspect_ui` actions, and the helper re-checks it live. `selectText` writes `AXSelectedTextRange` (UTF-16 units) and reads it back. Both are AX-only: they never fall back to coordinates and stay allowed in strict headless mode. `secondaryAction` reports `worked` only when a value, selection or window change is observed, otherwise `unknown` (an AX `cannotComplete` failure is also `unknown`, and only a dead element is retried); an opened menu appears in `rootDelta`. Both are implemented on macOS only; Linux and Windows fail them with `unsupported_command`.

## Synthesized delivery

Web-backed editable controls and controls without usable AX actions can require synthesized keyboard or pointer events. Background events use [`CGEvent.postToPid(_:)`](https://developer.apple.com/documentation/coregraphics/cgevent/posttopid%28_%3A%29). Foreground delivery activates and raises the target before posting at the [CG event tap](https://developer.apple.com/documentation/coregraphics/cgevent/post%28tap%3A%29).

`paste` writes the text to the general pasteboard, posts `cmd+v`, then restores every item of the previous clipboard, unless something else wrote to the clipboard in the meantime (`performed.clipboardRestored` says which). It is the robust path for input methods that compose per-key typing. Under HID delivery it waits for the target to take focus and checks for a blocked focused app before snapshotting the clipboard, again before publishing the temporary item, and after the layout lookup just before posting `cmd+v`. A refusal before publication leaves the clipboard untouched. `cmd+v` presses the key whose Command-modified output on the active keyboard layout is `v` (macOS resolves Command shortcuts through the layout's Command key map: key 9 on QWERTY, Russian, Greek and "Dvorak - QWERTY Command", another key on plain Dvorak), falling back to key 9, and `paste` fails with `layout_unsupported` only when the layout is unreadable; the lookup runs after the focus checks, inside the temporary clipboard, so that failure restores the clipboard. The temporary item carries the `org.nspasteboard.TransientType`, `AutoGeneratedType` and `ConcealedType` markers so clipboard history managers skip it, and is written current-host-only so Universal Clipboard and Handoff never sync it to other devices. The restore is host-only too, because the original may itself be a host-only secret; an item that had synced is not re-synced. If the helper is killed mid-paste the restore never runs and the pasted text stays on the clipboard. The clipboard is restored once the target's value changed or after a short deadline; a target slower than that can still read the restored clipboard and paste it, so a `paste` that observes no change reports `unknown` (with `performed.pasteDeadlineExpired`) and is never retried automatically.

A `drag` reserves its mouse-up event before sending input. If it cannot create that event, it reports `input_failed` without posting anything. Once the button goes down, the helper posts the reserved release on completion or at the last posted point if interrupted.

These are synthesized events, not physical hardware input. Before foreground coordinate delivery, the helper hit-tests the intended point with AX. An unrelated resolved element produces `occluded_target`; an unavailable or coarse result remains unknown rather than proving visibility.

## Headless policy

`headless: true` is a strict prohibition, not a preference. It maps the transaction to the native `ax_only` policy. The helper fails these actions with `foreground_required` before it posts events or activates the target:

- coordinate delivery: raw `x`/`y` targets, `moveMouse`, `drag`, and press, click or scroll requests whose Accessibility operation is unavailable or fails;
- `typeText`, `paste` and `keypress`, including ref-targeted requests;
- `setText` inside web content, which needs synthesized keyboard input.

The bridge returns that error instead of retrying in the foreground. `ax_only` actions never display the agent cursor overlay.

Without strict headless mode, ref-based work normally starts in the background and can escalate only through checked fallback rules.

## Outcome evidence

Native results distinguish:

- `worked`: observable evidence supports the intended effect;
- `didnt`: checked evidence supports that the intended effect did not occur;
- `unknown`: delivery happened, but available evidence cannot prove the application-level result.

Text writes and text entry can use read-back evidence. When every action of an `act_ui` transaction is a `setText` whose field shows its text in the successor observation, the outcome becomes `worked`, unless the transaction carries an explicit error (`app_blocked`, `input_deadline_expired`, `postcondition_failed`): a field that already held the text proves nothing about a refused delivery. Pointer actions often need value, selection, focused-window, sheet, or root-delta changes; a successfully posted event alone is not universal proof. When the source root disappears after delivery, the result reports `target_closed` with its cause, as described in the [root targeting reference](./root-targeting.mdx#post-action-outcomes).

## Agent cursor overlay

When `cursor_overlay` is enabled, non-headless pointer actions delivered in the background with `postToPid` schedule the noninteractive AppKit/SwiftUI agent cursor at the grounded point. Foreground actions that control the physical cursor don't display the overlay. The overlay ignores mouse events, cannot become key or main, and hides automatically. It is visual only and currently limited to the main display.

For state ownership, batching, and successor observations, use the generated [agent state and action contract](../../agent/contract.mdx). For line-level implementation citations and every current limit, use the [complete macOS implementation reference](./implementation.mdx).
PI_DOCS_REFERENCE_END
*/

/*
PI_DOCS_REFERENCE_BEGIN reference/platforms/macos/root-targeting

These are the target, capture, modality, and post-action contracts the macOS path guarantees.

## Target contract

- A root target is `{ pid, windowId?, rootRef?, windowRef? }`. `windowId` is present only when positive. An unpaired root (no matching CG window) has no `windowId`, never `0`.
- `rootRef` and `windowRef` are the same native ref. Every macOS helper call (`look`, `focusWindow`, `axWaitFor`) goes through `normalizeTarget()` in [`src/platform/macos/backend.ts`](https://github.com/injaneity/pi-computer-use/blob/main/src/platform/macos/backend.ts), which sends only `windowRef`.
- For root targeting, the helper treats only a missing or null `windowId` as absent. All five request sites (`setWindowFrame`, `focusedElement`, `focusWindow`, `look`, `axWaitFor`) return `invalid_args` for a supplied ID that is not a positive unsigned 32-bit integer. The PID is validated first, so a request with both an invalid PID and an invalid ID reports `pid must be a positive 32-bit integer`. A `windowRef` that no longer resolves fails; it never falls back to the app's first window.
- Looks remember their `windowRef`, so `act` resolves the root by ref for unpaired roots.

## Capture

- Paired root: semantic and visual observation work.
- Unpaired root: semantic works. Visual fails with `root_not_capturable`; use `image: never`. No other window is ever captured in its place.

## Modality

`isModal` is true for: a sheet child, role `AXSheet`, or `AXModal == true`. When the app does not report `AXModal` at all, a dialog-like role/subrole still counts. An explicit `AXModal == false` wins: Fusion's BROWSER sidebar (subrole `AXDialog`, `AXModal=0`) is nonmodal.

`act_ui` no longer redirects to a foreground modal. Actions and the successor capture stay on the root the state belongs to; a modal that appears afterwards shows up in `rootDelta` as `appeared`. `observe_ui` without a root may still prefer a confirmed foreground modal.

## Post-action outcomes

Terminal `act_ui` results say the action was delivered, or say its delivery is unknown when the settled outcome is `unknown` without a stop (and not to replay it). A stopped transaction (`stoppedAt`, a keyboard stop or a timed-out or otherwise indeterminate action) is never called delivered, in a terminal or a successor result: its first line names the stopped action and its literal refusal or error code, the root observation follows on its own line, and the replay decision comes once. Only a first action refused with a code or `0` posted units says nothing was posted and a retry is safe; every other stop says not to replay the transaction (#1281). The result is also:

- `target_closed`, `cause: replaced`, `successors: [...]`: source root gone and new roots of the same pid appeared. Observe a successor via `find_roots`.
- `target_closed`, `cause: closed`: source root gone, nothing replaced it.
- `post_action_observation_failed` with code `root_stale`: root still listed or unknown but the ref no longer resolves. Rediscover with `find_roots`.
- The identity probe proves `target_closed` only from a complete listing: it asks for an authoritative
  listing, and a probe that fails leaves the outcome `post_action_observation_failed`, even after an
  empty listing. The Linux helper fails a PID-scoped listing that timed out. Every macOS `listRoots`
  reply carries `complete`, false when the `AXWindows` list, sheet sources (`AXSheets`, children and
  their roles) or a skipped window's size could not be read, or the list exceeds 128 windows, unless the
  process has exited. A failed size read is retried once unless the window's paired CG bounds already
  admit it, and the window is filtered on the retry's value. A partial listing still resolves the roots
  it names, e.g. an observed root among an app's first 128 windows, but a saved root only by its verified
  identity (native ref or window id), never by title or rank: `observe_ui` and `wait_for` fail with
  `inventory_incomplete` for a saved root the listing omits instead of binding a same-title window, and
  `observe_ui` without a root does the same for an omitted frontmost window. The macOS client fails an
  authoritative listing without `complete: true` with `inventory_incomplete` too, including a reply from
  an older external helper that has no `complete` field, and reads such a reply as partial.
  Native macOS `rootDelta` likewise reports `closed` only against a complete listing, and `appeared` or
  `focused` only after one. It matches a root across listings by its CG window id, or without one by
  kind, role, title and frame. A root whose key may differ from one listing to the next is left out of
  that comparison and makes its listing incomplete, so it never shows up as `closed` plus a new
  `appeared` root (#1287): one whose CG pairing read its title or frame unsuccessfully (a later
  successful read does not vouch for that pairing), and an unpaired one whose title, role, subrole,
  position or size read failed (a sheet without its own title takes its window's, read or not). Apart
  from that, a key two roots share is ambiguous: both are left out the same way, whether two unpaired
  roots read alike or two roots carry one CG window id. One rule keeps the pairing heuristic itself from
  deciding the comparison: a root claims a CG window when it scores 0 or more for it, or when its own
  pairing read failed (an unread title or frame could score anything), and a root is keyed by its CG
  window id only when it claims exactly one that no other root claims. Every claimant of a CG window two
  roots claim is left out, e.g. two sheets of equal geometry, or a window beside one whose pairing read
  failed, so neither the listing order nor an unread competitor can move an identity. Same-app windows
  stacked within a few points of each other can therefore report no `closed` or `appeared` change at
  all. Discovery and target resolution still list every such root. `focused` compares only read focus. The native helper
  payload carries a window's `isFocused`, `isMain` and `isMinimized` only when the AX reply is a
  `CFBoolean`; a failed, absent or non-boolean (e.g. numeric `0`) reply leaves the field out, never
  `false`, and an unpaired window whose minimized read was left out omits `isOnscreen` too. A sheet's
  `isMain` and `isMinimized` are constant `false`, not reads, and its `isFocused` is its window's read
  focus, as before: the native helper derives a sheet's flags unchanged, and selection, `find_roots`
  details and ref records show a sheet with its window's focus, not its own (unknown, not `false`, when
  that focus was unread). Only `rootDelta` uses a sheet's own `AXFocused`, kept apart as `ownFocus`. A root
  present in both listings reports `focused` only when its own focus read `false` before and `true`
  after (a window's `isFocused`, a sheet's `ownFocus`); unread focus on either side reports none
  (#1303), so a failed read can hide a real focus change but never invents one. A root new since a
  complete listing whose own focus reads `true` reports both `appeared` and `focused`. A popup menu's
  `isFocused` is stamped `true`, never read, so a new menu reports only `appeared`. The macOS TS client keeps an omitted or non-boolean flag `undefined` through `listRoots`, `find_roots` details
  (left out of the stored result) and restored ref records (#1314): ranking gives the not-minimized bonus only for an
  explicit boolean `false` and the focused, main and onscreen bonuses only for an explicit boolean `true` (a menu's
  stamped focus and a sheet's inherited focus count), `find_roots` orders a root by focus only when it is an explicit
  `true`, and a modal takes over the target only when it is explicitly onscreen, not explicitly minimized and in front
  by explicit focus or z-order. An unknown minimized state alone never costs such a modal the takeover. Windows listings carry no completeness information, so an empty listing from
  them is still read as closure.

## Ref lifecycle

Native refs live in the helper's `refStore` and are only valid while the helper process and the AX element live. Refs from earlier sessions, pids and state ids are stale: rediscover with `find_roots`.

## Tests

`npm run test:macos-target`, `test:macos-native` (links the real production Swift sources with a headless test entry), `test:act-outcomes`.
PI_DOCS_REFERENCE_END
*/

/*
PI_DOCS_REFERENCE_BEGIN reference/platforms/macos/implementation

This page describes the current macOS implementation, not an intended design. Apple links establish the platform API semantics; source links establish what this project actually does.

For focused lookup, use [Accessibility and AX](./accessibility.mdx), [Capture and OCR](./capture.mdx), [Actions and input delivery](./actions.mdx), or [Root targeting](./root-targeting.mdx). This complete page remains the source-backed inventory of requirements, helper behavior, and current limits.

## Support boundary

The helper requires macOS 14 or newer because it is compiled with a `14.0` deployment target and uses `SCScreenshotManager`, which Apple introduced in macOS 14 ([Apple: `SCScreenshotManager`](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager), [setup-helper.mjs](https://github.com/injaneity/pi-computer-use/blob/main/scripts/setup-helper.mjs#L46), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L3177)). Builds target Apple silicon and Intel (`arm64` and `x86_64`) ([setup-helper.mjs](https://github.com/injaneity/pi-computer-use/blob/main/scripts/setup-helper.mjs#L42)).

The normal runtime uses the per-user `~/Applications/pi-computer-use.app`; existing writable system-wide installs remain at `/Applications/pi-computer-use.app`, and `PI_COMPUTER_USE_HELPER_APP_PATH` selects an explicit location ([helper-path.mjs](https://github.com/injaneity/pi-computer-use/blob/main/src/platform/macos/helper-path.mjs#L15)). The bundle identifier is `com.injaneity.pi-computer-use`, and the daemon listens on a Unix-domain socket below `~/Library/Caches/pi-computer-use/`. The TypeScript client launches the resolved app with `open -n -g <app> --args serve …` and communicates with its daemon over that socket ([helper.ts](https://github.com/injaneity/pi-computer-use/blob/main/src/platform/macos/helper.ts#L19), [helper.ts](https://github.com/injaneity/pi-computer-use/blob/main/src/platform/macos/helper.ts#L169)). The app is an `LSUIElement`, so it is packaged as an agent-style app rather than a normal Dock app ([setup-helper.mjs](https://github.com/injaneity/pi-computer-use/blob/main/scripts/setup-helper.mjs#L405)).

## Permissions

Two grants are required for the complete feature set:

- Accessibility is checked with `AXIsProcessTrusted()` and requested with `AXIsProcessTrustedWithOptions(_:)` ([Apple: `AXIsProcessTrusted`](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted), [Apple: `AXIsProcessTrustedWithOptions`](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L872)). It enables Accessibility API observation and actions.
- Screen Recording is preflighted and requested with `CGPreflightScreenCaptureAccess()` and `CGRequestScreenCaptureAccess()` ([Apple: preflight](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess%28%29), [Apple: request](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess%28%29), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L872)). It enables window image capture.

The extension reports Screen Recording as ready only when the helper can also retrieve nonempty display content through `SCShareableContent`. Apple documents that API as retrieving matching displays, apps, and windows; the project uses it as an additional readiness check, not as an Apple-defined permission-status API ([Apple: `getExcludingDesktopWindows`](https://developer.apple.com/documentation/screencapturekit/scshareablecontent/getexcludingdesktopwindows%28_%3Aonscreenwindowsonly%3Acompletionhandler%3A%29), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L812)).

Setup invokes the request APIs before opening the relevant System Settings pane, then restarts the helper after the user chooses recheck ([permissions.ts](https://github.com/injaneity/pi-computer-use/blob/main/src/platform/macos/permissions.ts#L82), [permissions.ts](https://github.com/injaneity/pi-computer-use/blob/main/src/platform/macos/permissions.ts#L136)). The helper reports `source.attribution: helper-app` only when its executable path is inside the installed bundle and its parent PID is 1; every other launch reports `caller` ([bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L836)). This is a project launch diagnostic, not an Apple API statement about grant ownership.

The documentation does not promise a particular pane label, automatic listing behavior, or grant persistence across re-signing because those details are not stable API contracts.

## Root discovery

Discovery combines three sources:

1. `NSWorkspace.runningApplications` supplies running-process identity and frontmost state ([Apple: `runningApplications`](https://developer.apple.com/documentation/appkit/nsworkspace/runningapplications), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L951)).
2. `AXUIElementCreateApplication` plus Accessibility window attributes supplies controllable windows, roles, state, and element trees. An empty `AXWindows` list falls back to `AXMainWindow` and `AXFocusedWindow` ([Apple: `AXUIElement`](https://developer.apple.com/documentation/applicationservices/axuielement), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L1260)).
3. `CGWindowListCopyWindowInfo` supplies session window IDs, bounds, layers, owner PIDs, titles, onscreen state, and ordering candidates ([Apple: `CGWindowListCopyWindowInfo`](https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo%28_%3A_%3A%29), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L2936)).

Single-window lookups call `CGWindowListCreateDescriptionFromArray(_:)` for the requested window ID first and fall back to an all-window `CGWindowListCopyWindowInfo` query when that returns no match ([Apple: `CGWindowListCreateDescriptionFromArray`](https://developer.apple.com/documentation/coregraphics/cgwindowlistcreatedescriptionfromarray%28_%3A%29), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L3317)).

Accessibility windows and Core Graphics windows do not share one project-owned identifier, so the helper pairs them heuristically using title, frame geometry, onscreen state, and one-to-one assignment. The returned metadata exposes `exact`, `high`, or `low` pairing confidence instead of presenting every match as certain ([bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L3080)). Roots without a match are unpaired and omit `windowId`; the [root targeting reference](./root-targeting.mdx) defines how they are addressed. A failed title or frame read adds nothing to a pairing score, so it can neither pair a window nor cost it its match. A sheet carries a `windowId` only when it pairs with a CG window no window took, never its window's; and since one helper process never gives two roots one native ref, the client re-identifies a saved root by `windowId` only when the listed root's native ref is from another helper process, never in place of a different ref from the same one, and only as the same kind of root: a saved sheet never re-identifies as a window, nor a saved window as a sheet (a target restored from a session file carries no kind and keeps the `windowId` alone). `rootDelta` keys a paired root by its `windowId` and an unpaired one by kind, role, title and frame; a root whose pairing or identity reads failed, whose key another root shares, or whose CG window claim is not exclusive (it scores 0 or more for, or failed to read for, more than one CG window, or another root claims one of them), is excluded from that comparison and makes the listing incomplete, but it is not removed from discovery: it still resolves as a positive match.

Windows, sheets, dialogs, popovers, and open menus can become roots. Menus are identified by the Accessibility `AXMenu` role and Core Graphics popup-menu window level; a menu with no matching Accessibility element remains an outline-only, `pictureOnly` root ([bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L1232), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L3004)).

## Observation and capture

A look walks the target Accessibility subtree breadth-first and reads roles, subroles, identifiers, titles, descriptions, values, frames, focus, actions, and settable attributes. The walk stops at 2,000 nodes, 20 seconds after the root node was built, or 25 seconds after the look started (the client gives up at 33), whichever comes first, and marks incomplete ancestors, and nodes whose `AXChildren` read failed, as `truncated` ([`LookOutlineWorld.build` in bridge.swift](https://github.com/nredd/pi-harness/blob/main/packages/computer-use/native/macos/bridge.swift)).

When an image is requested, the helper:

1. retrieves the matching `SCWindow` from `SCShareableContent`;
2. builds an `SCContentFilter` for that desktop-independent window;
3. sets `showsCursor = false` and `ignoreShadowsSingleWindow = true`;
4. captures one frame with `SCScreenshotManager.captureImage` ([Apple: capture one image](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager/captureimage%28contentfilter%3Aconfiguration%3Acompletionhandler%3A%29), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L3202)).

If ScreenCaptureKit times out or fails, the helper tries `/usr/sbin/screencapture -x -l <window-id>` and reads the temporary PNG with owner-only file permissions ([bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L3277)). The fallback is an implementation detail, not a guarantee that capture succeeds when ScreenCaptureKit fails. Unpaired roots fail visual observation with `root_not_capturable` instead of capturing another window ([bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L1367)).

Forced visual text recognition uses Vision's accurate `VNRecognizeTextRequest`, disables language correction, and attaches nonduplicate text boxes to the Accessibility outline. Apple defines that request as finding and recognizing text in an image ([Apple: `VNRecognizeTextRequest`](https://developer.apple.com/documentation/vision/vnrecognizetextrequest), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L1637)). OCR-only nodes are marked `pictureOnly` and cannot receive ref-targeted Accessibility actions.

## Actions and delivery

The helper prefers Accessibility operations where the target exposes them:

- press and eligible click actions use `AXUIElementPerformAction` with `AXPress` ([Apple: `AXUIElementPerformAction`](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L2079));
- `setText` writes `AXValue` and reads it back ([Apple: `AXUIElementSetAttributeValue`](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L2093));
- semantic scrolling walks the target and its ancestors looking for supported Accessibility scroll actions ([bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L2467)).

Web-backed editable controls and controls without a usable Accessibility action can require synthesized keyboard or pointer events. Background event delivery uses `CGEvent.postToPid(_:)`; foreground delivery activates and raises the target, then posts the synthesized event at `.cghidEventTap` ([Apple: `postToPid`](https://developer.apple.com/documentation/coregraphics/cgevent/posttopid%28_%3A%29), [Apple: `post(tap:)`](https://developer.apple.com/documentation/coregraphics/cgevent/post%28tap%3A%29), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L3362)). These are synthesized events; this documentation does not describe them as physical hardware input.

`headless: true` maps every native action to the `ax_only` policy. The helper rejects coordinate delivery, `typeText`, `keypress`, and web text replacement with `foreground_required` before posting synthesized events, and the bridge does not escalate that error ([bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L1922)). Without strict headless mode, ref-based actions normally start with background delivery; coordinate clicks and focus-dependent steps can start in foreground, while checked keyboard failures and explicit `foreground_required` errors can escalate there ([bridge.ts](https://github.com/injaneity/pi-computer-use/blob/main/src/bridge.ts#L1185), [bridge.ts](https://github.com/injaneity/pi-computer-use/blob/main/src/bridge.ts#L1208)).

Before foreground coordinate delivery, the helper uses `AXUIElementCopyElementAtPosition` to check whether the point resolves to the intended element or a related ancestor or descendant. An unrelated resolved element produces `occluded_target`; an unavailable or coarse hit test produces an unknown preflight rather than proof of visibility ([bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L2021), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L2440)).

Action results distinguish `worked`, `didnt`, and `unknown`. A successful API call or posted event is not universally treated as proof of application-level effect: value writes and text entry get read-back evidence, while pointer actions can remain unknown unless value, selection, focused-window, or sheet state changes ([bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L2079), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L2197)).

## Agent cursor overlay

When `cursor_overlay` is enabled, non-headless pointer-oriented actions delivered in the background with `postToPid` schedule the AppKit/SwiftUI `AgentCursor` overlay at the grounded point; foreground actions that control the physical cursor and `ax_only` actions don't display it ([bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L1982)). The overlay ignores mouse events, cannot become key or main, and hides after eight seconds ([Apple: `ignoresMouseEvents`](https://developer.apple.com/documentation/appkit/nswindow/ignoresmouseevents), [agent_cursor.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/agent_cursor.swift#L6)). It is visual only; action delivery remains in `bridge.swift`.

The current overlay is main-display-only because its frame is created from `NSScreen.main`. The helper excludes its own process from app discovery, but the overlay is not a supported target ([agent_cursor.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/agent_cursor.swift#L61), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L951)).

## Activity glow

`activity_glow` defaults to `false`. When it is enabled and `headless` is `false`, the extension sends `setActivityGlow` over a persistent helper connection when a computer-use tool starts and clears it when the agent run ends ([computer-use.ts](https://github.com/injaneity/pi-computer-use/blob/main/extensions/computer-use.ts#L207)). The helper's `ActivityGlowController` tracks active connections and shows the glow while any is active; a closed connection removes its state ([bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L485), [bridge.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L634), [activity_glow.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/activity_glow.swift#L74)). It creates one borderless window per `NSScreen`, rebuilt when screen parameters change. Each window ignores mouse events, is excluded from Accessibility, and sits at the screen-saver level ([activity_glow.swift](https://github.com/injaneity/pi-computer-use/blob/main/native/macos/activity_glow.swift#L130)).

## Current limits

- Accessibility completeness and supported actions depend on what the target app exposes; sparse or web-backed trees can require image evidence or foreground event delivery.
- Accessibility-to-Core-Graphics window pairing is heuristic, and callers must treat low-confidence pairing accordingly. Unpaired roots support semantic observation only.
- Raw coordinate targets require an image-bearing look; outline-only menu roots cannot be coordinate targets.
- ScreenCaptureKit readiness, capture, and the command-line screenshot fallback are separate checks, so one successful check does not guarantee every later window capture.
- The visual agent cursor only covers the main display.
- Strict headless mode rejects actions that need synthesized pointer or keyboard input, including every `typeText` and `keypress`.
PI_DOCS_REFERENCE_END
*/
