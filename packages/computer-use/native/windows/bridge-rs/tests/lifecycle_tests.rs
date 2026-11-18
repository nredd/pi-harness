//! Real helper executable/pipe lifecycle, not Windows UI or interop proof on a host.
use std::io::{Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

struct Helper(Child);

impl Helper {
    fn spawn() -> Self {
        Self(
            Command::new(env!("CARGO_BIN_EXE_windows-bridge"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn owned helper executable"),
        )
    }

    fn diagnostics(&mut self) {
        self.0
            .stdin
            .as_mut()
            .expect("owned input pipe")
            .write_all(
                b"{\"protocolVersion\":4,\"id\":\"fixture\",\"cmd\":\"diagnostics\",\"args\":{}}\n",
            )
            .expect("send diagnostic frame to owned helper");
    }

    fn wait_bounded(&mut self) -> ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.0.try_wait().expect("query owned helper exit") {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "helper did not terminate after its protocol peer disappeared"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        // Always reap only this fixture, including a failed lifecycle assertion.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn input_eof_drains_the_readiness_frame_then_stops() {
    let mut helper = Helper::spawn();
    helper.diagnostics();
    drop(helper.0.stdin.take());
    assert!(helper.wait_bounded().success());
    let mut output = String::new();
    helper
        .0
        .stdout
        .as_mut()
        .expect("owned response pipe")
        .read_to_string(&mut output)
        .expect("read completed frame");
    let response: serde_json::Value =
        serde_json::from_str(&output).expect("one complete response frame");
    assert_eq!(response["id"], "fixture");
    assert_eq!(response["protocolVersion"], 4);
    assert_eq!(
        response["result"]["capabilities"],
        serde_json::json!(["fail-closed-live-target-v1"])
    );
}

#[test]
fn lost_output_is_terminal_even_when_input_remains_open() {
    let mut helper = Helper::spawn();
    drop(helper.0.stdout.take());
    helper.diagnostics();
    assert_eq!(helper.wait_bounded().code(), Some(3));
}
