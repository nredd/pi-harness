//! Headless contracts for the real protocol, state ownership and error implementations.
//! No accessibility bus, display server or physical input is used.

use linux_bridge::atspi::{AccessibleRef, NodeSnapshot, Rect, RootSnapshot};
use linux_bridge::protocol::PROTOCOL_VERSION;
use linux_bridge::state::{fresh_state_id, HelperState, MAX_LOOK_RECORDS};
use linux_bridge::{ErrorCode, ProtocolError, Request, Response};
use serde_json::json;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Construct a synthetic identity without connecting to AT-SPI.
fn accessible(n: usize) -> AccessibleRef {
    AccessibleRef {
        destination: format!(":1.{n}"),
        path: format!("/node/{n}"),
    }
}

/// Construct an in-memory root with optional screenshot dimensions.
fn root(n: usize, frame: Option<Rect>) -> RootSnapshot {
    RootSnapshot {
        accessible: accessible(n),
        pid: n as u64,
        name: format!("root {n}"),
        app_name: "fixture".into(),
        role: "frame".into(),
        frame,
        x11_window: None,
        is_focused: false,
        is_minimized: false,
        z_order: None,
    }
}

/// Construct a node as an external caller, without test-only production helpers.
fn node(n: usize) -> NodeSnapshot {
    NodeSnapshot {
        reference: String::new(),
        accessible: accessible(n),
        parent: None,
        name: String::new(),
        role: String::new(),
        description: String::new(),
        value: String::new(),
        interfaces: std::collections::HashSet::new(),
        bounds: None,
        is_secure: false,
        depth: 0,
    }
}

#[test]
fn malformed_requests_are_rejected_without_coercion() {
    for input in [
        "{",
        "null",
        "[]",
        r#"{"protocolVersion":4,"id":"a","cmd":"diagnostics"}"#,
        r#"{"protocolVersion":"4","id":"a","cmd":"diagnostics","args":{}}"#,
        r#"{"protocolVersion":4,"id":7,"cmd":"diagnostics","args":{}}"#,
        r#"{"protocolVersion":4,"id":"a","cmd":null,"args":{}}"#,
        r#"{"protocolVersion":-1,"id":"a","cmd":"diagnostics","args":{}}"#,
        r#"{"protocolVersion":4294967296,"id":"a","cmd":"diagnostics","args":{}}"#,
        r#"{"protocolVersion":4,"protocolVersion":4,"id":"a","cmd":"diagnostics","args":{}}"#,
    ] {
        assert!(serde_json::from_str::<Request>(input).is_err(), "{input}");
    }
    // Version negotiation belongs to the dispatcher, not the deserializer.
    let request: Request = serde_json::from_value(json!({
        "protocolVersion": 0, "id": "request", "cmd": "unknown", "args": [null, true]
    }))
    .unwrap();
    assert_eq!(request.protocol_version, 0);
    assert_eq!(request.id, "request");
    assert_eq!(request.cmd, "unknown");
    assert_eq!(request.args, json!([null, true]));
}

#[test]
fn transport_refuses_bad_envelopes_versions_and_commands_then_drains_eof() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_linux-bridge"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // All requests stop before any desktop/backend operation. Responses may complete out of order.
    let input = concat!(
        "\n{\n",
        "{\"protocolVersion\":4,\"id\":\"malformed\",\"cmd\":false,\"args\":{}}\n",
        "{\"protocolVersion\":0,\"id\":\"version\",\"cmd\":\"diagnostics\",\"args\":{}}\n",
        "{\"protocolVersion\":4,\"id\":\"command\",\"cmd\":\"not-a-command\",\"args\":{}}\n"
    );
    let written = child.stdin.take().unwrap().write_all(input.as_bytes());
    let deadline = Instant::now() + Duration::from_secs(10);
    let exited = loop {
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                break false;
            }
        }
    };
    // Reap before asserting, including timeout or write failures.
    let output = child.wait_with_output().unwrap();
    assert!(exited, "helper did not drain EOF within the deadline");
    written.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses = String::from_utf8(output.stdout).unwrap();
    let responses = responses
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 4);
    for (id, code, message) in [
        ("unknown", "invalid_request", "Invalid request:"),
        ("malformed", "invalid_request", "Invalid request:"),
        (
            "version",
            "invalid_request",
            "Unsupported Linux helper protocol 0; expected 4.",
        ),
        (
            "command",
            "unsupported_command",
            "Unknown command 'not-a-command'",
        ),
    ] {
        let response = responses
            .iter()
            .find(|response| response["id"] == id)
            .unwrap();
        assert_eq!(response["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(response["ok"], false);
        assert!(response.get("result").is_none());
        assert_eq!(response["error"]["code"], code);
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with(message));
    }
}

#[test]
fn responses_preserve_ids_and_omit_the_opposite_payload() {
    let id = "request\n\"☃";
    let success = serde_json::to_value(Response::ok(id, json!(null))).unwrap();
    assert_eq!(
        success,
        json!({"protocolVersion": PROTOCOL_VERSION, "id": id, "ok": true, "result": null})
    );
    let failure = serde_json::to_value(Response::err(
        id,
        ProtocolError::new("refused", ErrorCode::InvalidRequest),
    ))
    .unwrap();
    assert_eq!(
        failure,
        json!({"protocolVersion": PROTOCOL_VERSION, "id": id, "ok": false,
            "error": {"message": "refused", "code": "invalid_request"}})
    );
}

#[test]
fn every_error_has_the_stable_wire_code_and_display() {
    for (code, wire) in [
        (ErrorCode::CapabilityDeferred, "capability_deferred"),
        (ErrorCode::UnsupportedCommand, "unsupported_command"),
        (ErrorCode::InvalidRequest, "invalid_request"),
        (ErrorCode::TargetNotFound, "target_not_found"),
        (ErrorCode::InternalError, "internal_error"),
        (ErrorCode::UnsupportedPlatform, "unsupported_platform"),
        (ErrorCode::CaptureFailed, "capture_failed"),
        (ErrorCode::StaleLook, "stale_look"),
        (ErrorCode::StaleRef, "stale_ref"),
        (
            ErrorCode::CoordinateUnavailableForRoot,
            "coordinate_unavailable_for_root",
        ),
        (ErrorCode::CoordinateBlocked, "coordinate_blocked"),
        (ErrorCode::ForegroundRequired, "foreground_required"),
        (ErrorCode::SecureTextUnreadable, "secure_text_unreadable"),
    ] {
        assert_eq!(serde_json::to_value(code).unwrap(), wire);
        assert_eq!(code.to_string(), wire);
        let error = ProtocolError::new(String::from("refused"), code);
        assert_eq!(error.code, code);
        assert_eq!(error.message, "refused");
        assert_eq!(error.to_string(), format!("[{wire}] refused"));
        let domain_error: &dyn std::error::Error = &error;
        assert!(domain_error.source().is_none());
    }
}

#[test]
fn roots_are_sorted_reused_removed_and_never_resurrect_old_refs() {
    let mut state = HelperState::default();
    assert!(state.roots().is_empty());
    let initial = state.replace_roots(vec![root(1, None), root(2, None), root(3, None)]);
    let replaced = state.replace_roots(vec![root(3, None), root(1, None)]);
    assert_eq!(replaced[0].0, initial[2].0);
    assert_eq!(replaced[1].0, initial[0].0);
    let sorted = state.roots();
    assert_eq!(
        sorted.iter().map(|entry| &entry.0).collect::<Vec<_>>(),
        vec![&initial[0].0, &initial[2].0]
    );
    assert_eq!(state.root(&initial[0].0).unwrap().accessible, accessible(1));
    assert!(state.root(&initial[1].0).is_none());
    assert!(state.root("missing").is_none());
    state.replace_roots(vec![]);
    assert!(state.roots().is_empty());
    let returned = state.replace_roots(vec![root(1, None)]);
    assert_ne!(returned[0].0, initial[0].0);
}

#[test]
fn image_dimensions_clamp_frames_and_updates_without_mutating_base() {
    let mut state = HelperState::default();
    for (width, height, expected) in [
        (-20, 0, (1, 1)),
        (i32::MAX, 100, (u16::MAX, 100)),
        (320, i32::MAX, (320, u16::MAX)),
    ] {
        let (id, _) = state.insert_look(
            root(
                1,
                Some(Rect {
                    x: 0,
                    y: 0,
                    width,
                    height,
                }),
            ),
            vec![],
            None,
        );
        let record = state.look(&id).unwrap();
        assert_eq!((record.image_width, record.image_height), expected);
    }
    let (id, _) = state.insert_look(root(1, None), vec![], None);
    let record = state.look(&id).unwrap();
    assert_eq!((record.image_width, record.image_height), (1, 1));
    state.set_look_image_size(&id, 640, 480).unwrap();
    let base = state.look(&id).unwrap();
    let (child, _) = state.insert_look(root(2, None), vec![node(9)], Some(&base));
    state.set_look_image_size(&child, 0, 0).unwrap();
    let record = state.look(&child).unwrap();
    assert_eq!((record.image_width, record.image_height), (1, 1));
    assert_eq!(record.root.accessible, accessible(2));
    let unchanged = state.look(&id).unwrap();
    assert_eq!((unchanged.image_width, unchanged.image_height), (640, 480));
    assert_eq!(
        state.set_look_image_size("missing", 1, 1).unwrap_err().code,
        ErrorCode::StaleLook
    );
}

#[test]
fn scope_uses_newest_owner_and_refuses_missing_or_expired_ownership() {
    let mut state = HelperState::default();
    assert_eq!(
        state.scope("missing", None).unwrap_err().code,
        ErrorCode::StaleRef
    );
    let (first, nodes) = state.insert_look(root(1, None), vec![node(9)], None);
    let reference = &nodes[0].reference;
    let base = state.look(&first).unwrap();
    let mut updated = nodes[0].clone();
    updated.name = "newest".into();
    let (second, _) = state.insert_look(root(1, None), vec![updated], Some(&base));
    assert_eq!(state.scope(reference, None).unwrap().1.name, "newest");
    assert_eq!(state.scope(reference, Some(&first)).unwrap().1.name, "");
    assert_eq!(
        state.scope("missing", Some(&second)).unwrap_err().code,
        ErrorCode::StaleRef
    );
    assert_eq!(
        state.scope(reference, Some("missing")).unwrap_err().code,
        ErrorCode::StaleLook
    );
    assert_eq!(
        state.element(&second, "missing").unwrap_err().code,
        ErrorCode::StaleRef
    );
    assert_eq!(
        state.element("missing", reference).unwrap_err().code,
        ErrorCode::StaleLook
    );
    assert_eq!(state.look(&second).unwrap().nodes.len(), 1);
    for n in 0..MAX_LOOK_RECORDS {
        state.insert_look(root(n, None), vec![], None);
    }
    assert_eq!(state.look(&first).unwrap_err().code, ErrorCode::StaleLook);
    assert_eq!(
        state.scope(reference, Some(&second)).unwrap_err().code,
        ErrorCode::StaleLook
    );
    assert_eq!(
        state.scope(reference, None).unwrap_err().code,
        ErrorCode::StaleRef
    );
    assert_eq!(
        state.element(&second, reference).unwrap_err().code,
        ErrorCode::StaleLook
    );
    assert_eq!(
        state.set_look_image_size(&second, 10, 10).unwrap_err().code,
        ErrorCode::StaleLook
    );
}

#[test]
fn fresh_state_ids_are_unique_across_threads() {
    let threads = (0..8)
        .map(|_| std::thread::spawn(fresh_state_id))
        .collect::<Vec<_>>();
    let ids = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), 8);
    assert!(ids.iter().all(|id| id
        .strip_prefix("w-")
        .is_some_and(|number| number.parse::<u64>().is_ok_and(|n| n > 0))));
}
