//! Headless test support: a scripted [`InputSink`] that records every post.
//!
//! Built only for this crate's tests (`cfg(test)` or the `testing` feature its
//! dev-dependency enables), so the shipped helper does not expose it.
#![cfg(any(test, feature = "testing"))]
use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use serde_json::Value;

use x11rb::protocol::xproto::{Keycode, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, KEY_PRESS_EVENT};

use crate::x11::{observable_button, InputSink, InputState, PostFailure};
use crate::{ErrorCode, ProtocolError};

/// One event a [`RecordingSink`] applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PostedEvent {
    pub event: u8,
    pub detail: u8,
    pub x: i32,
    pub y: i32,
    /// Whether an admission check immediately preceded this post.
    pub admitted: bool,
}

/// Headless sink that records applied posts, tracks which keys and buttons are
/// down, and refuses, fails, loses acknowledgments or panics on a script.
///
/// Post attempts are numbered from zero in call order. Keycodes are assigned in
/// first-use order from 8, the lowest X11 keycode.
#[derive(Debug, Default)]
pub struct RecordingSink {
    events: RefCell<Vec<PostedEvent>>,
    keymap: RefCell<Vec<u32>>,
    /// `(is_button, detail)` currently down, for anyone.
    down: RefCell<BTreeSet<(bool, u8)>>,
    pending_admission: Cell<bool>,
    admissions: Cell<usize>,
    point_admissions: Cell<usize>,
    attempts: Cell<usize>,
    refuse_admission_after: Option<usize>,
    refuse_points: bool,
    cover_points_after: Option<usize>,
    unmapped: Option<u32>,
    fail_posts: Vec<usize>,
    lost_acks: Vec<(usize, bool)>,
    panic_posts: Vec<usize>,
    panic_after_posts: Vec<usize>,
    cancel_after: Option<(usize, Arc<InputState>)>,
    query_fails: bool,
    /// Pointer mapping, physical to logical; identity for buttons 1 to 10 when unset.
    pointer_map: Option<Vec<u8>>,
    /// Sleep inside every post, as a slow server round trip would.
    post_delay: Duration,
    /// Announce each post attempt as it begins, so a test waits for that instead of
    /// sleeping: on `Stderr`, a `linux-bridge testing: posting <id> <attempt>` line.
    announce: Option<Announce>,
    /// Hold every post open, after its announcement, until the test sends on (or
    /// drops) the paired sender.
    hold_open: Option<mpsc::Receiver<()>>,
}

/// Where a [`RecordingSink`] announces post attempts.
#[derive(Debug)]
enum Announce {
    Stderr(String),
    Channel(mpsc::Sender<usize>),
}
impl RecordingSink {
    /// Build a sink from a JSON script, for process-level tests that drive the real
    /// binary: `{"delayMs": 20, "failPosts": [1], "held": [[false, 8]], "announce": "id"}`.
    pub fn scripted(script: &Value) -> Self {
        let numbers = |key: &str| {
            script
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_u64)
                .map(|n| n as usize)
                .collect::<Vec<_>>()
        };
        let mut sink = Self {
            fail_posts: numbers("failPosts"),
            post_delay: Duration::from_millis(
                script.get("delayMs").and_then(Value::as_u64).unwrap_or(0),
            ),
            announce: script
                .get("announce")
                .and_then(Value::as_str)
                .map(|id| Announce::Stderr(id.to_owned())),
            ..Self::default()
        };
        for held in script
            .get("held")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let (Some(button), Some(detail)) = (
                held.get(0).and_then(Value::as_bool),
                held.get(1).and_then(Value::as_u64),
            ) {
                sink = sink.held(button, detail as u8);
            }
        }
        sink
    }

    /// Admit the first `admissions` checks, then refuse with `foreground_required`.
    pub fn refuse_admission_after(mut self, admissions: usize) -> Self {
        self.refuse_admission_after = Some(admissions);
        self
    }
    /// Reject the post at zero-based `attempt` definitively: nothing is applied.
    pub fn fail_post(mut self, attempt: usize) -> Self {
        self.fail_posts.push(attempt);
        self
    }
    /// Lose the acknowledgment of the post at `attempt`: it is uncertain to the
    /// caller, and applied to the desktop only when `applied`.
    pub fn lose_ack(mut self, attempt: usize, applied: bool) -> Self {
        self.lost_acks.push((attempt, applied));
        self
    }
    /// Panic inside the post at `attempt`, before anything is applied.
    pub fn panic_post(mut self, attempt: usize) -> Self {
        self.panic_posts.push(attempt);
        self
    }
    /// Apply the post at `attempt`, then panic before acknowledging it.
    pub fn panic_after_post(mut self, attempt: usize) -> Self {
        self.panic_after_posts.push(attempt);
        self
    }
    /// Refuse every point admission with `coordinate_blocked`.
    pub fn refuse_points(mut self) -> Self {
        self.refuse_points = true;
        self
    }
    /// Admit the first `admissions` point checks, then report the point covered.
    pub fn cover_points_after(mut self, admissions: usize) -> Self {
        self.cover_points_after = Some(admissions);
        self
    }
    /// Report `sym` as missing from the keymap.
    pub fn unmapped(mut self, sym: u32) -> Self {
        self.unmapped = Some(sym);
        self
    }
    /// Start with the key (or button) `detail` already held by another client.
    pub fn held(self, button: bool, detail: u8) -> Self {
        self.down.borrow_mut().insert((button, detail));
        self
    }
    /// Cancel `state` after `posts` posts were applied, as a shutdown signal would.
    pub fn cancel_after(mut self, posts: usize, state: Arc<InputState>) -> Self {
        self.cancel_after = Some((posts, state));
        self
    }
    /// Send each post attempt's number on `posts` as the attempt begins.
    pub fn announce_posts(mut self, posts: mpsc::Sender<usize>) -> Self {
        self.announce = Some(Announce::Channel(posts));
        self
    }
    /// Hold each post open until `release` receives, so a test decides when it ends.
    pub fn hold_posts_until(mut self, release: mpsc::Receiver<()>) -> Self {
        self.hold_open = Some(release);
        self
    }
    /// Fail every key and button state query.
    pub fn query_fails(mut self) -> Self {
        self.query_fails = true;
        self
    }
    /// Use `map` as the pointer mapping (`map[physical - 1]` is the logical button).
    pub fn pointer_mapping(mut self, map: &[u8]) -> Self {
        self.pointer_map = Some(map.to_vec());
        self
    }
    /// Events applied so far, in post order.
    pub fn events(&self) -> Vec<PostedEvent> {
        self.events.borrow().clone()
    }
    /// `(is_button, detail)` currently down, in order.
    pub fn held_inputs(&self) -> Vec<(bool, u8)> {
        self.down.borrow().iter().copied().collect()
    }
    fn apply(&self, event: u8, detail: u8, x: i32, y: i32, admitted: bool) {
        let button = matches!(event, BUTTON_PRESS_EVENT | BUTTON_RELEASE_EVENT);
        if matches!(event, KEY_PRESS_EVENT | BUTTON_PRESS_EVENT) {
            self.down.borrow_mut().insert((button, detail));
        } else {
            self.down.borrow_mut().remove(&(button, detail));
        }
        self.events.borrow_mut().push(PostedEvent {
            event,
            detail,
            x,
            y,
            admitted,
        });
        if let Some((posts, state)) = &self.cancel_after {
            if self.events.borrow().len() >= *posts {
                state.cancel();
            }
        }
    }
}
impl InputSink for RecordingSink {
    fn admit(&self) -> Result<(), ProtocolError> {
        let admissions = self.admissions.get();
        if self
            .refuse_admission_after
            .is_some_and(|limit| admissions >= limit)
        {
            return Err(ProtocolError::new(
                "Recorded target is no longer active",
                ErrorCode::ForegroundRequired,
            ));
        }
        self.admissions.set(admissions + 1);
        self.pending_admission.set(true);
        Ok(())
    }
    fn admit_point(&self, _x: i32, _y: i32) -> Result<(), ProtocolError> {
        // A refused point voids the admission before it.
        let admitted = self.pending_admission.replace(false);
        if self.refuse_points {
            return Err(ProtocolError::new(
                "Recorded point is outside the target",
                ErrorCode::CoordinateBlocked,
            ));
        }
        let admissions = self.point_admissions.get();
        if self
            .cover_points_after
            .is_some_and(|limit| admissions >= limit)
        {
            return Err(ProtocolError::new(
                "Recorded point is covered by another window",
                ErrorCode::OccludedTarget,
            ));
        }
        self.point_admissions.set(admissions + 1);
        self.pending_admission.set(admitted);
        Ok(())
    }
    fn keycode(&self, sym: u32) -> Result<Option<Keycode>, ProtocolError> {
        if self.unmapped == Some(sym) {
            return Ok(None);
        }
        let mut keymap = self.keymap.borrow_mut();
        let index = keymap
            .iter()
            .position(|&known| known == sym)
            .unwrap_or_else(|| {
                keymap.push(sym);
                keymap.len() - 1
            });
        Ok(Some(8 + index as u8))
    }
    /// Like the live adapter, a button is observable only when the pointer mapping
    /// makes it logical button 1 to 5.
    fn is_down(&self, button: bool, detail: u8) -> Result<Option<bool>, ProtocolError> {
        if self.query_fails {
            return Err(ProtocolError::new(
                "Recorded state query failed",
                ErrorCode::InternalError,
            ));
        }
        let identity = (1..=10).collect::<Vec<u8>>();
        let map = self.pointer_map.as_deref().unwrap_or(&identity);
        if button && observable_button(map, detail).is_none() {
            return Ok(None);
        }
        Ok(Some(self.down.borrow().contains(&(button, detail))))
    }
    fn post(&self, event: u8, detail: u8, x: i32, y: i32) -> Result<(), PostFailure> {
        let admitted = self.pending_admission.replace(false);
        let attempt = self.attempts.replace(self.attempts.get() + 1);
        match &self.announce {
            Some(Announce::Stderr(id)) => eprintln!("linux-bridge testing: posting {id} {attempt}"),
            Some(Announce::Channel(posts)) => {
                let _ = posts.send(attempt);
            }
            None => {}
        }
        if let Some(release) = &self.hold_open {
            let _ = release.recv();
        }
        if !self.post_delay.is_zero() {
            std::thread::sleep(self.post_delay);
        }
        if self.panic_posts.contains(&attempt) {
            panic!("recorded post {attempt} panicked");
        }
        if self.fail_posts.contains(&attempt) {
            return Err(PostFailure::Rejected(ProtocolError::new(
                "Recorded post was rejected",
                ErrorCode::InternalError,
            )));
        }
        if let Some(&(_, applied)) = self.lost_acks.iter().find(|(at, _)| *at == attempt) {
            if applied {
                self.apply(event, detail, x, y, admitted);
            }
            return Err(PostFailure::Uncertain(ProtocolError::new(
                "Recorded post acknowledgment was lost",
                ErrorCode::InternalError,
            )));
        }
        self.apply(event, detail, x, y, admitted);
        if self.panic_after_posts.contains(&attempt) {
            panic!("recorded post {attempt} panicked after it was applied");
        }
        Ok(())
    }
}
