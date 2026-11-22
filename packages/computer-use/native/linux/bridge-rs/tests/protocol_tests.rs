use linux_bridge::protocol::PROTOCOL_VERSION;
use linux_bridge::{ErrorCode, ProtocolError, Request, Response};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

/// Upper bound for any single wait on the helper process.
const DEADLINE: Duration = Duration::from_secs(10);

/// A spawned helper whose reads and waits are bounded by a deadline. Dropping it kills
/// and reaps a child that is still running, so a failing assertion never leaks or
/// hangs on a helper that ignores its shutdown.
struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    stderr: Receiver<String>,
}
impl Helper {
    /// Spawn the helper with no display, so physical input can never reach a desktop.
    fn spawn() -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_linux-bridge"));
        command
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("XDG_SESSION_TYPE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().expect("spawn linux helper");
        let stdout = child.stdout.take().expect("piped stdout");
        let (line_tx, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line_tx.send(line).is_err() {
                    return;
                }
            }
        });
        let mut stderr_pipe = child.stderr.take().expect("piped stderr");
        let (stderr_tx, stderr) = mpsc::channel();
        thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr_pipe.read_to_string(&mut text);
            let _ = stderr_tx.send(text);
        });
        let stdin = child.stdin.take();
        Self {
            child,
            stdin,
            lines,
            stderr,
        }
    }
    fn send(&mut self, request: &Value) {
        let stdin = self.stdin.as_mut().expect("stdin still open");
        writeln!(stdin, "{request}").expect("write request");
        stdin.flush().expect("flush request");
    }
    /// The next reply, or a panic once `DEADLINE` passes.
    fn reply(&self) -> Value {
        let line = self
            .lines
            .recv_timeout(DEADLINE)
            .expect("helper replied before the deadline");
        serde_json::from_str(&line).expect("reply is JSON")
    }
    fn close_stdin(&mut self) {
        drop(self.stdin.take());
    }
    fn signal(&self, name: &str) {
        let status = Command::new("kill")
            .args([format!("-{name}"), self.child.id().to_string()])
            .status()
            .expect("run kill");
        assert!(status.success(), "kill -{name} failed");
    }
    /// The exit status within `limit`, or a panic (the drop then kills and reaps).
    fn wait(&mut self, limit: Duration) -> ExitStatus {
        let start = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().expect("poll helper") {
                return status;
            }
            assert!(
                start.elapsed() < limit,
                "helper still running after {limit:?}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
    /// Everything the helper wrote to stderr; call after it exited.
    fn stderr(&self) -> String {
        self.stderr.recv_timeout(DEADLINE).unwrap_or_default()
    }
}
impl Drop for Helper {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

fn diagnostics(id: &str) -> Value {
    json!({"protocolVersion": PROTOCOL_VERSION, "id": id, "cmd": "diagnostics", "args": {}})
}

#[test]
fn protocol_round_trip_matches_other_helpers() {
    let request: Request = serde_json::from_value(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "id": "linux-1",
        "cmd": "diagnostics",
        "args": {}
    }))
    .unwrap();
    let response = Response::ok(&request.id, json!({"backend":"at-spi2"}));
    let value = serde_json::to_value(response).unwrap();
    assert_eq!(value["protocolVersion"], 5);
    assert_eq!(value["id"], "linux-1");
    assert_eq!(value["result"]["backend"], "at-spi2");
}

#[test]
fn errors_have_stable_machine_codes() {
    let response = Response::err(
        "linux-2",
        ProtocolError::new("no screenshot", ErrorCode::CaptureFailed),
    );
    let value = serde_json::to_value(response).unwrap();
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["code"], "capture_failed");
}

#[test]
fn diagnostics_response_is_flushed_after_stdin_eof() {
    let mut helper = Helper::spawn();
    helper.send(&diagnostics("eof-1"));
    helper.close_stdin();
    let status = helper.wait(DEADLINE);
    let stderr = helper.stderr();
    assert!(status.success(), "helper failed: {stderr}");
    assert!(
        !stderr.contains("panicked"),
        "helper panicked during shutdown: {stderr}"
    );
    let response = helper.reply();
    assert_eq!(response["id"], "eof-1");
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["protocolVersion"], PROTOCOL_VERSION);
    assert!(
        helper.lines.try_recv().is_err(),
        "expected exactly one response"
    );
}

#[test]
fn termination_signals_drain_and_exit_cleanly() {
    for signal in ["TERM", "INT"] {
        let mut helper = Helper::spawn();
        // One reply proves the handlers are installed: they register before the first read.
        helper.send(&diagnostics("sig"));
        assert_eq!(helper.reply()["id"], "sig");
        helper.signal(signal);
        // Stdin stays open, so only the signal can end the helper here.
        let status = helper.wait(DEADLINE);
        assert!(
            status.success(),
            "SIG{signal} must drain and exit 0, not kill the helper: {status:?}"
        );
    }
}

/// A `testingAct` request typing `text` through a scripted recording sink.
fn typing(id: &str, text: &str, sink: Value) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "id": id,
        "cmd": "testingAct",
        "args": {"action": "typeText", "params": {"text": text}, "sink": sink}
    })
}

/// Read `count` replies, keyed by request id.
fn replies(helper: &Helper, count: usize) -> HashMap<String, Value> {
    (0..count)
        .map(|_| {
            let reply = helper.reply();
            (reply["id"].as_str().expect("reply id").to_owned(), reply)
        })
        .collect()
}

#[test]
fn shutdown_with_full_request_queue() {
    for ending in ["TERM", "INT", "EOF"] {
        let mut helper = Helper::spawn();
        helper.send(&diagnostics("ready"));
        assert_eq!(helper.reply()["id"], "ready");
        // Four posts per capital at 25 ms each: about 20 s, with shift held for most of it.
        helper.send(&typing("hold", &"A".repeat(200), json!({"delayMs": 25})));
        // Let it take the action lock first; request tasks race for it otherwise.
        thread::sleep(Duration::from_millis(200));
        // Seven requests take the remaining workers and wait for the action lock; the
        // eighth waits for a worker in the reader, which saturates the queue.
        for n in 0..8 {
            helper.send(&typing(&format!("queued-{n}"), "a", json!({})));
        }
        thread::sleep(Duration::from_millis(300));
        if ending == "EOF" {
            helper.close_stdin();
        } else {
            helper.signal(ending);
        }
        let status = helper.wait(Duration::from_secs(5));
        assert!(status.success(), "{ending}: {status:?} {}", helper.stderr());
        let replies = replies(&helper, 9);
        let hold = &replies["hold"]["result"];
        assert_eq!(hold["outcome"], "unknown", "{ending}: {hold}");
        assert_eq!(hold["error"]["code"], "cancelled", "{ending}: {hold}");
        assert_eq!(
            hold["evidence"]["held"],
            json!([]),
            "{ending}: shift released"
        );
        for n in 0..8 {
            let queued = &replies[&format!("queued-{n}")];
            assert_eq!(queued["ok"], false, "{ending}: {queued}");
            assert_eq!(queued["error"]["code"], "cancelled", "{ending}: {queued}");
        }
    }
}

#[test]
fn shutdown_with_release_debt() {
    let mut helper = Helper::spawn();
    // Shift's release is rejected on the normal path and again in cleanup.
    helper.send(&typing("held", "A", json!({"failPosts": [3, 4]})));
    let reply = helper.reply();
    assert_eq!(reply["result"]["outcome"], "unknown", "{reply}");
    assert_eq!(
        reply["result"]["evidence"]["unconfirmedReleases"],
        json!(["keycode 8"])
    );
    helper.close_stdin();
    let status = helper.wait(DEADLINE);
    let stderr = helper.stderr();
    // No display here, so the bounded exit settlement cannot confirm it.
    assert_eq!(status.code(), Some(3), "{stderr}");
    assert!(stderr.contains("keycode 8"), "{stderr}");
    assert!(stderr.contains("restart Pi"), "{stderr}");
}
