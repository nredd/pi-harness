import CoreGraphics
import Foundation

/// Deterministic assertions against the production sampler and renderer, without an overlay.
@MainActor
func runCursorMotionAssertions() {
    func check(_ condition: Bool, _ message: String) {
        if !condition { print("FAIL: motion: \(message)"); exit(1) }
    }
    func near(_ actual: Double, _ expected: Double) -> Bool {
        abs(actual - expected) < 0.000001
    }
    func state(_ actual: DubinsPlannedPath.State, _ x: Double, _ y: Double, _ heading: Double, _ message: String) {
        check(near(actual.x, x) && near(actual.y, y) && near(actual.heading, heading), message)
    }
    func linear(_ from: Double, _ to: Double) -> DubinsPlannedPath {
        DubinsPlannedPath(kind: .linear, length: 10, endVisualHeading: to, targetPoint: CGPoint(x: 9, y: 14),
                          x0: 3, y0: 6, th0: from, R: 2, seg1: 0, seg2: 0, seg3: 0, types: [],
                          x1: 9, y1: 14, th1: to)
    }

    // Direct pure seams cover numeric boundaries that normal overlay timing cannot reach.
    let rotation = AgentCursorRenderer()
    check(near(rotation.rotateToward(current: 0, desired: -2 * .pi + 0.05, maxStep: 0.1), 0.05),
          "negative wrapped turn takes the short positive correction")
    check(near(rotation.rotateToward(current: 0, desired: 2 * .pi + 0.4, maxStep: 0.1), 0.1),
          "positive wrapped turn respects the step bound")
    check(near(rotation.rotateToward(current: 0, desired: -0.05, maxStep: 0.1), -0.05),
          "short negative turn does not overshoot")
    check(mod2pi(-Double.leastNonzeroMagnitude) == 2 * .pi,
          "negative subnormal remainder receives the floating point correction")
    check(mod2pi(Double.leastNonzeroMagnitude) == Double.leastNonzeroMagnitude,
          "positive subnormal remainder is retained")

    // Same-turn circle centers nearly coincide. Cancellation makes the expanded squared
    // distance negative in one candidate, while the opposite-turn candidate stays valid.
    let separation = 0.00627
    let angle = asin(separation / 2)
    for sign in [-1.0, 1.0] {
        let end = CGPoint(x: separation * 80, y: 0)
        guard let path = planDubins(x0: 0, y0: 0, th0: -sign * angle,
                                   x1: end.x, y1: end.y, th1: sign * angle,
                                   R: 80, endVisualHeading: 0, targetPoint: end) else {
            check(false, "near-coincident circle centers retain a feasible candidate")
            return
        }
        check(path.length.isFinite && path.length > 0, "cancellation candidate is rejected without poisoning the path")
        let endpoint = path.sample(at: path.length)
        // Cancellation near coincident centers costs a few millionths of a pixel.
        check(hypot(endpoint.x - end.x, endpoint.y - end.y) < 0.00001,
              "numerically feasible path still reaches its endpoint")
    }

    // All candidate arithmetic overflows for these finite poses. The renderer must use
    // its linear fallback, not retain a nonfinite candidate. No real pointer is moved.
    let extreme = AgentCursorRenderer()
    let extremeStart = CGPoint(x: 1e200, y: 0)
    extreme.setInitialPosition(extremeStart)
    extreme.moveTo(point: CGPoint(x: -1e200, y: 0))
    extreme.tick(now: 0)
    extreme.tick(now: 0.01)
    check(extreme.position.x.isFinite && extreme.position.y.isFinite && extreme.heading.isFinite,
          "finite extreme coordinates fall back without nonfinite motion")
    check(near(extreme.heading, .pi / 4), "linear numerical fallback retains the visual heading")
    extreme.cancelAnimation()

    let line = linear(0, .pi / 2)
    state(line.sample(at: -10), 3, 6, 0, "linear distance clamps below zero")
    state(line.sample(at: 5), 6, 10, .pi / 4, "linear midpoint interpolates position and heading")
    state(line.sample(at: 20), 9, 14, .pi / 2, "linear distance clamps beyond endpoint")
    state(linear(3 * .pi / 4, -3 * .pi / 4).sample(at: 5), 6, 10, .pi, "linear heading wraps positively across pi")
    state(linear(-3 * .pi / 4, 3 * .pi / 4).sample(at: 5), 6, 10, -.pi, "linear heading wraps negatively across pi")

    // Radius 2: quarter left arc -> straight 4 -> quarter right arc.
    // Independent analytic endpoints: (2,2,pi/2), (2,6,pi/2), (4,8,0).
    let curve = DubinsPlannedPath(kind: .dubins, length: 2 * .pi + 4, endVisualHeading: 0,
                                 targetPoint: CGPoint(x: 4, y: 8), x0: 0, y0: 0, th0: 0, R: 2,
                                 seg1: .pi / 2, seg2: 2, seg3: .pi / 2, types: ["L", "S", "R"],
                                 x1: 4, y1: 8, th1: 0)
    state(curve.sample(at: -1), 0, 0, 0, "Dubins negative distance stays at origin")
    state(curve.sample(at: 0), 0, 0, 0, "Dubins zero distance stays at origin")
    state(curve.sample(at: .pi / 2), sqrt(2), 2 - sqrt(2), .pi / 4, "left arc midpoint turns counterclockwise")
    state(curve.sample(at: .pi), 2, 2, .pi / 2, "first segment boundary")
    state(curve.sample(at: .pi + 2), 2, 4, .pi / 2, "straight segment advances along heading")
    state(curve.sample(at: .pi + 4), 2, 6, .pi / 2, "second segment boundary")
    state(curve.sample(at: 1.5 * .pi + 4), 4 - sqrt(2), 6 + sqrt(2), .pi / 4, "right arc midpoint turns clockwise")
    state(curve.sample(at: curve.length), 4, 8, 0, "Dubins endpoint")
    state(curve.sample(at: curve.length + 20), 4, 8, 0, "Dubins distance clamps beyond endpoint")

    let offset = cos(Double.pi / 4) * 16
    func target(_ click: CGPoint) -> CGPoint { CGPoint(x: click.x + offset, y: click.y + offset) }
    func settled(_ renderer: AgentCursorRenderer, _ click: CGPoint, _ label: String) {
        for frame in 0..<2400 where renderer.isAnimating { renderer.tick(now: Double(frame) / 120) }
        check(!renderer.isAnimating, "\(label) settles within twenty seconds")
        check(hypot(renderer.position.x - target(click).x, renderer.position.y - target(click).y) < 0.000001,
              "\(label) settles exactly at visual offset")
        check(near(renderer.heading, .pi / 4), "\(label) settles at visual heading")
        let position = renderer.position
        renderer.tick(now: 100)
        check(renderer.position == position && !renderer.isAnimating, "\(label) idle tick is inert")
    }
    for delta in [0.0, 0.25, 0.5, 0.500001] {
        let renderer = AgentCursorRenderer()
        let click = CGPoint(x: 100, y: 200)
        let start = CGPoint(x: target(click).x - delta, y: target(click).y)
        renderer.setInitialPosition(start)
        renderer.moveTo(point: click)
        renderer.tick(now: 0)
        check(renderer.position == start, "first tick has zero elapsed time")
        settled(renderer, click, "distance \(delta)")
    }

    // Finite geometry through the only production planner caller. Near/far targets in
    // every quadrant exercise feasible and infeasible turning-circle candidates.
    for radius in [1.0, 40, 160, 800] {
        for step in 0..<16 {
            let angle = Double(step) * .pi / 8
            let click = CGPoint(x: radius * cos(angle) - offset, y: radius * sin(angle) - offset)
            let renderer = AgentCursorRenderer()
            renderer.setInitialPosition(.zero)
            renderer.moveTo(point: click)
            settled(renderer, click, "radius \(radius), angle \(step)")
        }
    }

    // Retarget while turning, so accumulated headings cross both wrap boundaries.
    let turning = AgentCursorRenderer()
    turning.setInitialPosition(.zero)
    var time = 0.0
    for step in 0..<128 {
        let angle = Double(step) * .pi / 4
        turning.moveTo(point: CGPoint(x: 800 * cos(angle), y: 800 * sin(angle)))
        for _ in 0..<20 {
            let previousHeading = turning.heading
            time += 1.0 / 120
            turning.tick(now: time)
            check(turning.position.x.isFinite && turning.position.y.isFinite, "retargeted trajectory stays finite")
            check(abs(turning.heading - previousHeading) <= 14.0 / 120 + 0.000001,
                  "retargeted heading follows the bounded shortest turn")
        }
    }
    turning.cancelAnimation()

    let renderer = AgentCursorRenderer()
    let twin = AgentCursorRenderer()
    for cursor in [renderer, twin] {
        cursor.setInitialPosition(.zero)
        cursor.moveTo(point: CGPoint(x: 500, y: -300))
        cursor.tick(now: 10)
    }
    renderer.tick(now: 100)
    twin.tick(now: 10.05)
    check(hypot(renderer.position.x - twin.position.x, renderer.position.y - twin.position.y) < 0.000001,
          "long frame caps motion to fifty milliseconds")
    check(near(renderer.heading, twin.heading), "long frame caps heading rotation too")
    let before = renderer.position
    renderer.cancelAnimation()
    renderer.tick(now: 200)
    check(renderer.position == before && !renderer.isAnimating, "cancellation preserves current position")
    renderer.moveTo(point: CGPoint(x: -100, y: 70))
    renderer.tick(now: 0)
    check(renderer.position == before, "replacement resets the frame clock")
    settled(renderer, CGPoint(x: -100, y: 70), "replacement")
    renderer.moveTo(point: .zero)
    renderer.setInitialPosition(CGPoint(x: 7, y: 9))
    renderer.tick(now: 500)
    check(renderer.position == CGPoint(x: 7, y: 9) && !renderer.isAnimating, "initial position cancels pending path")
    print("macos deterministic cursor motion checks passed")
}
