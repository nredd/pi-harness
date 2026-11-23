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
}

impl Request {
    /// The request deadline on this process's monotonic clock, or `None` without both
    /// `deadlineMs` and `budgetMs`: the earlier of `deadlineMs` read against the wall clock
    /// now, which counts the time the line spent in the pipe, and `budgetMs` from
    /// `received`, when the line was read, which no wall-clock step can extend. Whichever
    /// estimate is wrong can only make the deadline earlier.
    pub fn deadline(&self, received: Instant) -> Option<Instant> {
        self.deadline_at(received, Instant::now(), SystemTime::now())
    }

    /// [`Self::deadline`] with `now` and `wall` read together by the caller.
    pub fn deadline_at(
        &self,
        received: Instant,
        now: Instant,
        wall: SystemTime,
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
        Some(by_wall.min(by_budget))
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
