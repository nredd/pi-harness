//! Fail-closed decision boundary between live UIA evidence and physical input.
//!
//! UIA and Win32 are external dependencies. Callers supply their current results,
//! never screenshot coordinates, and keep the physical-input lease throughout.

use crate::{ErrorCode, ProtocolError};

/// Observe the result of an already delivered mutation exactly once.
/// Post-delivery read failures cannot acknowledge that no action happened.
pub fn observe_after_delivery<T>(
    read: impl FnOnce() -> Result<T, ProtocolError>,
) -> Result<T, ProtocolError> {
    read().map_err(|error| {
        ProtocolError::uncertain(
            format!("Post-delivery observation failed: {error}"),
            error.code,
        )
    })
}

/// A delivered value write must not invite replay when read-back differs.
pub fn verify_written_text(expected: &str, actual: &str) -> Result<(), ProtocolError> {
    if expected != actual {
        return Err(ProtocolError::uncertain(
            "Delivered UIA value write did not read back exactly; refusing replay",
            ErrorCode::InternalError,
        ));
    }
    Ok(())
}

/// Physical screen bounds in the helper's per-monitor-aware coordinate space.
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    /// Left edge, including negative virtual desktop origins.
    pub x: f64,
    /// Top edge.
    pub y: f64,
    /// Positive width.
    pub width: f64,
    /// Positive height.
    pub height: f64,
}

impl Bounds {
    /// Whether all edges are finite and the rectangle has positive extent.
    pub fn valid(self) -> bool {
        [
            self.x,
            self.y,
            self.width,
            self.height,
            self.x + self.width,
            self.y + self.height,
        ]
        .iter()
        .all(|value| value.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }

    /// Containment of an actual integer pixel; right/bottom edges are exclusive.
    pub fn contains(self, x: f64, y: f64) -> bool {
        self.valid()
            && x.is_finite()
            && y.is_finite()
            && x >= self.x
            && y >= self.y
            && x < self.x + self.width
            && y < self.y + self.height
    }
}

/// Validate the whole path before the first mutation, never skipping a vertex.
pub fn validate_path(
    window: Bounds,
    target: Option<Bounds>,
    points: &[(f64, f64)],
    mut hit: impl FnMut(f64, f64) -> Result<bool, ProtocolError>,
) -> Result<(), ProtocolError> {
    if points.is_empty() {
        return Err(ProtocolError::new(
            "No resolved input points",
            ErrorCode::CoordinateBlocked,
        ));
    }
    for &(x, y) in points {
        if x != x.round()
            || y != y.round()
            || !window.contains(x, y)
            || target.is_some_and(|bounds| !bounds.contains(x, y))
        {
            return Err(ProtocolError::new(
                "Input vertex is outside its current target",
                ErrorCode::CoordinateBlocked,
            ));
        }
        if !hit(x, y)? {
            return Err(ProtocolError::new(
                "Input vertex is occluded",
                ErrorCode::OccludedTarget,
            ));
        }
    }
    Ok(())
}

/// Admit every vertex before invoking any mutation, including focus/restore.
pub fn deliver_path<T>(
    window: Bounds,
    target: Option<Bounds>,
    points: &[(f64, f64)],
    hit: impl FnMut(f64, f64) -> Result<bool, ProtocolError>,
    mutate: impl FnOnce() -> Result<T, ProtocolError>,
) -> Result<T, ProtocolError> {
    validate_path(window, target, points, hit)?;
    mutate()
}

/// Focus is a mutation even when the API or its verification fails.
pub fn deliver_focus(
    set: impl FnOnce() -> Result<(), ProtocolError>,
    verify: impl FnOnce() -> Result<bool, ProtocolError>,
) -> Result<(), ProtocolError> {
    observe_after_delivery(set)?;
    if !observe_after_delivery(verify)? {
        return Err(ProtocolError::uncertain(
            "Focus delivery could not be verified",
            ErrorCode::InternalError,
        ));
    }
    Ok(())
}

/// Walk actual hit identities; query failure never becomes ancestor evidence.
pub fn hit_ancestry<T>(
    target: &[i32],
    mut hit: T,
    mut identity: impl FnMut(&T) -> Result<Vec<i32>, ProtocolError>,
    mut parent: impl FnMut(&T) -> Result<Option<T>, ProtocolError>,
) -> Result<bool, ProtocolError> {
    if target.is_empty() {
        return Err(ProtocolError::new(
            "Missing target RuntimeId",
            ErrorCode::StaleRef,
        ));
    }
    for _ in 0..64 {
        let current = identity(&hit)?;
        if current.is_empty() {
            return Err(ProtocolError::new(
                "Missing hit RuntimeId",
                ErrorCode::StaleRef,
            ));
        }
        if current == target {
            return Ok(true);
        }
        let Some(next) = parent(&hit)? else {
            return Ok(false);
        };
        hit = next;
    }
    Ok(false)
}

/// Current identity and geometry read from the same live UIA element.
pub struct LiveTarget {
    /// UIA runtime identity; AutomationId alone is not authoritative.
    pub runtime_id: Vec<i32>,
    /// Fresh, physical screen bounds.
    pub bounds: Bounds,
}

/// Resolve, validate and hit-test a live target before delivering input once.
///
/// An external dependency error is a refusal, not permission to replay against
/// cached coordinates. The delivery callback is never retried, including when
/// it returns an error whose mutating outcome may be uncertain.
pub fn deliver_to_live_target<T>(
    expected_runtime_id: &[i32],
    window: Bounds,
    snapshot: impl FnOnce() -> Result<LiveTarget, ProtocolError>,
    hit_test: impl FnOnce(f64, f64) -> Result<bool, ProtocolError>,
    deliver: impl FnOnce(f64, f64) -> Result<T, ProtocolError>,
) -> Result<T, ProtocolError> {
    let target = snapshot()?;
    validate_live_target(expected_runtime_id, window, &target)?;
    let x = (target.bounds.x + target.bounds.width / 2.0).round();
    let y = (target.bounds.y + target.bounds.height / 2.0).round();
    if !window.contains(x, y) || !target.bounds.contains(x, y) {
        return Err(ProtocolError::new(
            "Rounded target is outside its bounds",
            ErrorCode::CoordinateBlocked,
        ));
    }
    if !hit_test(x, y)? {
        return Err(ProtocolError::new(
            "Target is occluded",
            ErrorCode::OccludedTarget,
        ));
    }
    deliver(x, y)
}

/// Read-only identity/geometry admission, before any foreground or focus mutation.
pub fn validate_live_target(
    expected_runtime_id: &[i32],
    window: Bounds,
    target: &LiveTarget,
) -> Result<(), ProtocolError> {
    if expected_runtime_id.is_empty() || target.runtime_id != expected_runtime_id {
        return Err(ProtocolError::new(
            "Element reference is stale",
            ErrorCode::StaleRef,
        ));
    }
    let bounds = target.bounds;
    if !window.valid()
        || !bounds.valid()
        || bounds.x < window.x
        || bounds.y < window.y
        || bounds.x + bounds.width > window.x + window.width
        || bounds.y + bounds.height > window.y + window.height
    {
        return Err(ProtocolError::new(
            "Live target bounds are outside the owning window",
            ErrorCode::CoordinateBlocked,
        ));
    }
    Ok(())
}
