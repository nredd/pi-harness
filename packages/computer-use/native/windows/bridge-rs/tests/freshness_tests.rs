//! Capture decisions use completed render evidence, not elapsed sleep.
use windows_bridge::freshness::{Frame, Freshness};

const RECT: (i32, i32, i32, i32) = (-900, 20, 800, 600);
const OLD: Frame = Frame {
    rect: RECT,
    fingerprint: 10,
};

#[test]
fn unchanged_cached_frames_never_prove_activation_freshness() {
    let mut freshness = Freshness::new(RECT, Some(10), true);
    for _ in 0..100 {
        assert!(!freshness.observe(OLD));
    }
}

#[test]
fn changed_then_stable_frame_proves_transition() {
    let mut freshness = Freshness::new(RECT, Some(10), true);
    let current = Frame {
        fingerprint: 20,
        ..OLD
    };
    assert!(!freshness.observe(OLD));
    assert!(!freshness.observe(current));
    assert!(freshness.observe(current));
}

#[test]
fn missing_baseline_pixels_are_not_evidence_of_change() {
    let mut freshness = Freshness::new(RECT, None, true);
    assert!(!freshness.observe(OLD));
    assert!(!freshness.observe(OLD));
}

#[test]
fn restored_rect_is_transition_evidence_without_baseline_pixels() {
    let mut freshness = Freshness::new((-21333, -21333, 200, 20), None, true);
    assert!(!freshness.observe(OLD));
    assert!(freshness.observe(OLD));
}

#[test]
fn already_active_static_window_needs_two_completed_renders() {
    let mut freshness = Freshness::new(RECT, None, false);
    assert!(!freshness.observe(OLD));
    assert!(freshness.observe(OLD));
}

#[test]
fn identical_active_and_inactive_window_settles_without_claiming_change() {
    let mut freshness = Freshness::new(RECT, Some(10), true);
    assert!(!freshness.observe(OLD));
    assert!(!freshness.settled(), "one render is not settled");
    assert!(
        !freshness.observe(OLD),
        "change evidence still never arrives"
    );
    assert!(freshness.settled());
}

#[test]
fn changing_animation_never_claims_stable_capture() {
    let mut freshness = Freshness::new(RECT, Some(10), true);
    for fingerprint in 11..50 {
        assert!(!freshness.observe(Frame { fingerprint, ..OLD }));
    }
}
