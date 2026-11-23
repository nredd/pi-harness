use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ProtocolError;

pub const PROTOCOL_VERSION: u32 = 11;

#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub id: String,
    pub cmd: String,
    pub args: Value,
    /// The client's absolute deadline in Unix epoch milliseconds (wall clock). Required
    /// from protocol 11 on, like `budgetMs`; the dispatcher refuses a request without both.
    #[serde(rename = "deadlineMs")]
    pub deadline_ms: Option<u64>,
    /// The same deadline as the milliseconds left when the client wrote the request.
    #[serde(rename = "budgetMs")]
    pub budget_ms: Option<u32>,
    /// Optional: the same deadline on `CLOCK_MONOTONIC` in milliseconds, sent by a client
    /// on this host (Node's `process.hrtime` reads that clock on Linux). Neither a
    /// wall-clock step nor time in the pipe can move it.
    #[serde(rename = "deadlineMonoMs", default)]
    pub deadline_mono_ms: Option<u64>,
}

/// `CLOCK_MONOTONIC` now in milliseconds, rounded up so a `deadlineMonoMs` is never read
/// as further off than it is.
pub fn monotonic_now_ms() -> u64 {
    let now = rustix::time::clock_gettime(rustix::time::ClockId::Monotonic);
    let nanos = u64::try_from(now.tv_sec)
        .unwrap_or(0)
        .saturating_mul(1_000_000_000)
        .saturating_add(u64::try_from(now.tv_nsec).unwrap_or(0));
    nanos.div_ceil(1_000_000)
}

impl Request {
    /// The request deadline on this process's monotonic clock, or `None` without both
    /// `deadlineMs` and `budgetMs`: the earliest of `deadlineMs` read against the wall
    /// clock now, `budgetMs` from `received`, when the line was read, and, when sent,
    /// `deadlineMonoMs` read against `CLOCK_MONOTONIC` now. An estimate that is wrong only
    /// makes it later when every other one is too: without `deadlineMonoMs`, a wall clock
    /// stepped back since the write and time in the pipe together make it late by the
    /// smaller of the two; `deadlineMonoMs` from the same clock is late by neither.
    pub fn deadline(&self, received: Instant) -> Option<Instant> {
        self.deadline_at(
            received,
            Instant::now(),
            SystemTime::now(),
            monotonic_now_ms(),
        )
    }

    /// [`Self::deadline`] with `now`, `wall` and `mono_ms` read together by the caller.
    pub fn deadline_at(
        &self,
        received: Instant,
        now: Instant,
        wall: SystemTime,
        mono_ms: u64,
    ) -> Option<Instant> {
        let budget = u64::from(self.budget_ms?);
        let wall_ms = wall.duration_since(UNIX_EPOCH).map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        });
        // Capped at the budget, which `received <= now` makes the later bound anyway: no
        // `deadlineMs`, however far off, can overflow the clock.
        let left = self.deadline_ms?.saturating_sub(wall_ms).min(budget);
        let by_wall = now + Duration::from_millis(left);
        let by_budget = received + Duration::from_millis(budget);
        let by_mono = self.deadline_mono_ms.map(|deadline| {
            now + Duration::from_millis(deadline.saturating_sub(mono_ms).min(budget))
        });
        let earlier = by_wall.min(by_budget);
        Some(by_mono.map_or(earlier, |by_mono| by_mono.min(earlier)))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Response {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtocolError>,
}

impl Response {
    pub fn ok(id: &str, result: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: id.to_owned(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: &str, error: ProtocolError) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: id.to_owned(),
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}
