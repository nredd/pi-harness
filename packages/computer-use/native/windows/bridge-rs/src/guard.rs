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
    if expected_runtime_id.is_empty() || target.runtime_id != expected_runtime_id {
        return Err(ProtocolError::new(
            "Element reference is stale",
            ErrorCode::StaleRef,
        ));
    }
    let bounds = target.bounds;
    let valid = |rect: Bounds| {
        [
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            rect.x + rect.width,
            rect.y + rect.height,
        ]
        .iter()
        .all(|value| value.is_finite())
            && rect.width > 0.0
            && rect.height > 0.0
    };
    if !valid(window)
        || !valid(bounds)
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
    let x = bounds.x + bounds.width / 2.0;
    let y = bounds.y + bounds.height / 2.0;
    if !hit_test(x, y)? {
        return Err(ProtocolError::new(
            "Target is occluded",
            ErrorCode::OccludedTarget,
        ));
    }
    deliver(x, y)
}
