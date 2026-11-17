//! Bounded capture acceptance decisions, independent of the GDI adapter.

/// Evidence from one completed selected-window render in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Frame {
    /// Unscaled physical window rectangle.
    pub rect: (i32, i32, i32, i32),
    /// Content fingerprint; used for change detection, not authentication.
    pub fingerprint: u64,
}

/// Require stable fresh evidence, not a sleep or success return from PrintWindow.
pub struct Freshness {
    baseline_rect: (i32, i32, i32, i32),
    baseline_fingerprint: Option<u64>,
    transition_required: bool,
    previous: Option<Frame>,
}

impl Freshness {
    /// Record the pre-restore/activation state. An unavailable baseline image
    /// cannot itself prove a frame changed; only a changed rectangle can then.
    pub fn new(
        rect: (i32, i32, i32, i32),
        fingerprint: Option<u64>,
        transition_required: bool,
    ) -> Self {
        Self {
            baseline_rect: rect,
            baseline_fingerprint: fingerprint,
            transition_required,
            previous: None,
        }
    }

    /// Accept only two matching renders after any required transition evidence.
    /// The caller owns the deadline and refuses when evidence never arrives.
    pub fn observe(&mut self, frame: Frame) -> bool {
        let changed = frame.rect != self.baseline_rect
            || self
                .baseline_fingerprint
                .is_some_and(|baseline| baseline != frame.fingerprint);
        let fresh = !self.transition_required || changed;
        let accepted = fresh && self.previous == Some(frame);
        self.previous = Some(frame);
        accepted
    }
}
