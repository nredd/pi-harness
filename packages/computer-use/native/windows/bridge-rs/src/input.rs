use serde_json::{json, Value};

use crate::error::{ErrorCode, ProtocolError};

#[derive(Debug, Clone, PartialEq)]
pub enum ActTarget {
    Ref(String),
    Point { x: f64, y: f64 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedActRequest {
    pub look_id: String,
    pub pid: Option<u64>,
    pub action: String,
    pub policy: String,
    pub target: ActTarget,
    pub params: Value,
}

pub fn parse_act_request(args: &Value) -> Result<ParsedActRequest, ProtocolError> {
    let look_id = args
        .get("lookId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("act requires lookId"))?
        .to_owned();
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("act requires action"))?
        .to_owned();
    let policy = args
        .get("policy")
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_owned();
    let target_value = args
        .get("target")
        .ok_or_else(|| invalid("act requires target"))?;
    let target = if let Some(reference) = target_value.get("ref").and_then(Value::as_str) {
        ActTarget::Ref(reference.to_owned())
    } else if let (Some(x), Some(y)) = (
        target_value.get("x").and_then(Value::as_f64),
        target_value.get("y").and_then(Value::as_f64),
    ) {
        ActTarget::Point { x, y }
    } else {
        return Err(invalid("act target must include ref or x/y"));
    };
    let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return Err(invalid("act params must be an object"));
    }
    match action.as_str() {
        "setText" | "typeText" if params.get("text").and_then(Value::as_str).is_none() => {
            return Err(invalid("text must be an explicit string"))
        }
        "press" | "click" => {
            if let Some(button) = params.get("button") {
                if !matches!(button.as_str(), Some("left" | "right" | "middle")) {
                    return Err(invalid("Unsupported mouse button"));
                }
            }
        }
        "keypress" => {
            if !params
                .get("keys")
                .and_then(Value::as_array)
                .is_some_and(|keys| {
                    !keys.is_empty()
                        && keys
                            .iter()
                            .all(|key| key.as_str().is_some_and(|name| !name.is_empty()))
                })
            {
                return Err(invalid("keys must contain only nonempty strings"));
            }
        }
        "scroll" => {
            for axis in ["scrollX", "scrollY"] {
                if params
                    .get(axis)
                    .is_some_and(|value| !value.as_f64().is_some_and(f64::is_finite))
                {
                    return Err(invalid("Scroll deltas must be finite numbers"));
                }
            }
        }
        "drag" | "moveMouse" | "setText" | "typeText" => {}
        _ => return Err(invalid("Unsupported action")),
    }
    Ok(ParsedActRequest {
        look_id,
        pid: args.get("pid").and_then(Value::as_u64),
        action,
        policy,
        target,
        params,
    })
}

/// Rebuild only public request fields; caller-derived resolution is never trusted.
pub fn executable_request(request: &ParsedActRequest) -> Value {
    fn public_params(value: &Value) -> Value {
        match value {
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .filter(|(key, _)| !key.starts_with("resolved"))
                    .map(|(key, value)| (key.clone(), public_params(value)))
                    .collect(),
            ),
            Value::Array(values) => Value::Array(values.iter().map(public_params).collect()),
            value => value.clone(),
        }
    }
    let target = match &request.target {
        ActTarget::Ref(reference) => json!({"ref":reference}),
        ActTarget::Point { x, y } => json!({"x":x,"y":y}),
    };
    json!({"lookId":request.look_id,"pid":request.pid,"action":request.action,
        "policy":request.policy,"target":target,"params":public_params(&request.params)})
}

pub fn policy_allows_raw_input(request: &ParsedActRequest) -> Result<(), ProtocolError> {
    if request.policy != "foreground" {
        Err(ProtocolError::new(
            "Background policy blocks global Windows coordinate/raw input grounding",
            if request.policy == "ax_only" {
                ErrorCode::CoordinateBlocked
            } else {
                ErrorCode::ForegroundRequired
            },
        ))
    } else {
        Ok(())
    }
}

pub fn response_with_delta(mut response: Value, source: &str, delta: Vec<Value>) -> Value {
    if !response
        .get("performed")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        response["performed"] = json!({});
    }
    response["performed"]["deltaSource"] = json!(source);
    if !delta.is_empty() {
        response["rootDelta"] = Value::Array(delta);
    }
    response
}

/// Send a paired Alt hint for an explicitly requested foreground transition.
/// The caller must own the physical-input lease for the complete transition.
pub fn foreground_hint() -> Result<(), ProtocolError> {
    #[cfg(windows)]
    {
        native::foreground_hint()
    }
    #[cfg(not(windows))]
    {
        Err(ProtocolError::new(
            "Foreground input requires Windows",
            ErrorCode::UnsupportedPlatform,
        ))
    }
}

pub fn open_browser_location(url: &str) -> Result<(), ProtocolError> {
    #[cfg(not(windows))]
    {
        let _ = url;
        Ok(())
    }
    #[cfg(windows)]
    {
        native::open_browser_location(url)
    }
}

pub fn act(args: &Value) -> Result<Value, ProtocolError> {
    act_with(args, dispatch)
}

/// Validate raw-input policy before entering the OS delivery boundary.
/// Tests inject delivery here, never a synthetic-input API or a foreground window.
fn act_with(
    args: &Value,
    deliver: impl FnOnce(&ParsedActRequest, &Value, &str) -> Result<Value, ProtocolError>,
) -> Result<Value, ProtocolError> {
    let request = parse_act_request(args)?;
    let grounding = args
        .get("resolvedPoint")
        .map(|_| "coordinates")
        .unwrap_or("description");

    if matches!(
        request.action.as_str(),
        "typeText" | "keypress" | "drag" | "moveMouse"
    ) {
        policy_allows_raw_input(&request)?;
    }
    if grounding == "coordinates" {
        policy_allows_raw_input(&request)?;
    }

    deliver(&request, args, grounding)
}

fn dispatch(
    request: &ParsedActRequest,
    args: &Value,
    grounding: &str,
) -> Result<Value, ProtocolError> {
    #[cfg(not(windows))]
    {
        let _ = (request, args);
        Ok(json!({
            "outcome": "unknown",
            "performed": { "grounding": grounding, "delivery": if grounding == "description" { "ax" } else { "hid" } },
            "evidence": { "platform": "non-windows-test-stub" }
        }))
    }

    #[cfg(windows)]
    {
        native::act(request, args, grounding)
    }
}

/// Run one physical-input operation and its bounded key/button release exactly once.
/// Cleanup also runs after partial OS failure; neither callback is retried. A
/// failed cleanup cannot report success; cleanup uncertainty outranks an ordinary refusal.
pub fn with_input_cleanup<T>(
    work: impl FnOnce() -> Result<T, ProtocolError>,
    release: impl FnOnce() -> Result<(), ProtocolError>,
) -> Result<T, ProtocolError> {
    let result = work();
    let cleanup = release();
    match (result, cleanup) {
        (Err(_), Err(cleanup)) if cleanup.outcome_uncertain() => Err(cleanup),
        (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(message.into(), ErrorCode::InvalidRequest)
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;

    pub fn foreground_hint() -> Result<(), ProtocolError> {
        press_chord(&[VK_MENU])
    }

    pub fn open_browser_location(url: &str) -> Result<(), ProtocolError> {
        hotkey(&[VK_CONTROL], VK_L)?;
        send_text(url)?;
        send(&[key(VK_RETURN, false), key(VK_RETURN, true)])
    }

    pub fn act(
        request: &ParsedActRequest,
        args: &Value,
        grounding: &str,
    ) -> Result<Value, ProtocolError> {
        let point = args.get("resolvedPoint").and_then(point_value);
        match request.action.as_str() {
            "press" | "click" => {
                let (x, y) = point.ok_or_else(|| invalid("click requires resolvedPoint"))?;
                click(
                    x,
                    y,
                    request
                        .params
                        .get("button")
                        .and_then(Value::as_str)
                        .unwrap_or("left"),
                )?;
                ok("unknown", grounding, "hid")
            }
            "moveMouse" => {
                let (x, y) = point.ok_or_else(|| invalid("moveMouse requires resolvedPoint"))?;
                unsafe { SetCursorPos(x, y) }.map_err(input_failed)?;
                ok("unknown", "coordinates", "hid")
            }
            "drag" => {
                let path = args
                    .get("resolvedPath")
                    .and_then(Value::as_array)
                    .ok_or_else(|| invalid("drag requires resolvedPath"))?;
                let points = path
                    .iter()
                    .map(point_value_required)
                    .collect::<Result<Vec<_>, _>>()?;
                drag(&points)?;
                ok("unknown", "coordinates", "hid")
            }
            "scroll" => {
                let (x, y) = point.ok_or_else(|| invalid("scroll requires resolvedPoint"))?;
                let dy = request
                    .params
                    .get("scrollY")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let dx = request
                    .params
                    .get("scrollX")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                scroll(x, y, dx, dy)?;
                ok("unknown", grounding, "hid")
            }
            "typeText" => {
                send_text(
                    request
                        .params
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                )?;
                ok("unknown", "coordinates", "hid")
            }
            "setText" => {
                if let Some((x, y)) = point {
                    click(x, y, "left")?;
                }
                hotkey(&[VK_CONTROL], VK_A)?;
                let text = request
                    .params
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                send_text(text)?;
                Ok(
                    json!({ "outcome": "unknown", "performed": { "grounding": grounding, "delivery": "hid" }, "evidence": { "value": text } }),
                )
            }
            "keypress" => {
                let keys = request
                    .params
                    .get("keys")
                    .and_then(Value::as_array)
                    .ok_or_else(|| invalid("keypress requires keys"))?;
                send_keys(keys)?;
                ok("unknown", "coordinates", "hid")
            }
            other => Err(ProtocolError::new(
                format!("Unsupported Windows action '{other}'"),
                ErrorCode::UnsupportedCommand,
            )),
        }
    }

    fn ok(outcome: &str, grounding: &str, delivery: &str) -> Result<Value, ProtocolError> {
        Ok(
            json!({ "outcome": outcome, "performed": { "grounding": grounding, "delivery": delivery } }),
        )
    }

    fn input_failed(error: impl std::fmt::Display) -> ProtocolError {
        ProtocolError::uncertain(format!("Input failed: {error}"), ErrorCode::CaptureFailed)
    }

    fn point_value(value: &Value) -> Option<(i32, i32)> {
        Some((
            value.get("x")?.as_f64()?.round() as i32,
            value.get("y")?.as_f64()?.round() as i32,
        ))
    }

    fn point_value_required(value: &Value) -> Result<(i32, i32), ProtocolError> {
        point_value(value).ok_or_else(|| invalid("point requires x and y"))
    }

    fn send(inputs: &[INPUT]) -> Result<(), ProtocolError> {
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == inputs.len() as u32 {
            Ok(())
        } else {
            Err(input_failed(format!(
                "SendInput inserted {sent}/{} events",
                inputs.len()
            )))
        }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, data: u32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dwFlags: flags,
                    mouseData: data,
                    ..Default::default()
                },
            },
        }
    }

    fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    dwFlags: if up {
                        KEYEVENTF_KEYUP
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    },
                    ..Default::default()
                },
            },
        }
    }

    fn unicode(ch: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wScan: ch,
                    dwFlags: KEYEVENTF_UNICODE
                        | if up {
                            KEYEVENTF_KEYUP
                        } else {
                            KEYBD_EVENT_FLAGS(0)
                        },
                    ..Default::default()
                },
            },
        }
    }

    fn click(x: i32, y: i32, button: &str) -> Result<(), ProtocolError> {
        unsafe { SetCursorPos(x, y) }.map_err(input_failed)?;
        let (down, up) = match button {
            "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        };
        with_input_cleanup(|| send(&[mouse(down, 0)]), || send(&[mouse(up, 0)]))
    }

    fn drag(points: &[(i32, i32)]) -> Result<(), ProtocolError> {
        if points.len() < 2 {
            return Err(invalid("drag requires at least two points"));
        }
        unsafe { SetCursorPos(points[0].0, points[0].1) }.map_err(input_failed)?;
        with_input_cleanup(
            || {
                send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0)])?;
                for &(x, y) in &points[1..] {
                    unsafe { SetCursorPos(x, y) }.map_err(input_failed)?;
                }
                Ok(())
            },
            || send(&[mouse(MOUSEEVENTF_LEFTUP, 0)]),
        )
    }

    fn scroll(x: i32, y: i32, dx: f64, dy: f64) -> Result<(), ProtocolError> {
        unsafe { SetCursorPos(x, y) }.map_err(input_failed)?;
        let mut inputs = Vec::new();
        if dy != 0.0 {
            inputs.push(mouse(
                MOUSEEVENTF_WHEEL,
                (-dy * 120.0).round() as i32 as u32,
            ));
        }
        if dx != 0.0 {
            inputs.push(mouse(
                MOUSEEVENTF_HWHEEL,
                (dx * 120.0).round() as i32 as u32,
            ));
        }
        if inputs.is_empty() {
            return Ok(());
        }
        send(&inputs)
    }

    fn send_text(text: &str) -> Result<(), ProtocolError> {
        let mut inputs = Vec::new();
        for unit in text.encode_utf16() {
            inputs.push(unicode(unit, false));
            inputs.push(unicode(unit, true));
        }
        send(&inputs)
    }

    fn send_keys(keys: &[Value]) -> Result<(), ProtocolError> {
        let names = keys.iter().filter_map(Value::as_str).collect::<Vec<_>>();
        if names.is_empty() {
            return Err(invalid("keypress requires at least one key"));
        }
        let vks = names
            .iter()
            .map(|name| vk_for(name).ok_or_else(|| invalid(format!("Unsupported key '{name}'"))))
            .collect::<Result<Vec<_>, _>>()?;
        press_chord(&vks)
    }

    fn hotkey(mods: &[VIRTUAL_KEY], key_vk: VIRTUAL_KEY) -> Result<(), ProtocolError> {
        let keys = mods
            .iter()
            .copied()
            .chain(std::iter::once(key_vk))
            .collect::<Vec<_>>();
        press_chord(&keys)
    }

    fn press_chord(keys: &[VIRTUAL_KEY]) -> Result<(), ProtocolError> {
        with_input_cleanup(
            || {
                for vk in keys {
                    send(&[key(*vk, false)])?;
                }
                Ok(())
            },
            || {
                send(
                    &keys
                        .iter()
                        .rev()
                        .map(|vk| key(*vk, true))
                        .collect::<Vec<_>>(),
                )
            },
        )
    }

    fn vk_for(name: &str) -> Option<VIRTUAL_KEY> {
        match name.to_ascii_lowercase().as_str() {
            "enter" | "return" => Some(VK_RETURN),
            "escape" | "esc" => Some(VK_ESCAPE),
            "tab" => Some(VK_TAB),
            "backspace" => Some(VK_BACK),
            "delete" => Some(VK_DELETE),
            "space" => Some(VK_SPACE),
            "left" | "arrowleft" => Some(VK_LEFT),
            "right" | "arrowright" => Some(VK_RIGHT),
            "up" | "arrowup" => Some(VK_UP),
            "down" | "arrowdown" => Some(VK_DOWN),
            "home" => Some(VK_HOME),
            "end" => Some(VK_END),
            "pageup" => Some(VK_PRIOR),
            "pagedown" => Some(VK_NEXT),
            "ctrl" | "control" => Some(VK_CONTROL),
            "shift" => Some(VK_SHIFT),
            "alt" | "option" => Some(VK_MENU),
            "cmd" | "win" | "meta" => Some(VK_LWIN),
            key if key.len() == 1 => {
                Some(VIRTUAL_KEY(key.as_bytes()[0].to_ascii_uppercase() as u16))
            }
            key if key.starts_with('f') => key[1..]
                .parse::<u16>()
                .ok()
                .filter(|n| (1..=24).contains(n))
                .map(|n| VIRTUAL_KEY(VK_F1.0 + n - 1)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_discriminated_click_request() {
        let parsed = parse_act_request(&json!({"lookId":"look_1","action":"click","policy":"default","target":{"ref":"@e1"},"params":{"button":"left"}})).unwrap();
        assert_eq!(parsed.action, "click");
        assert_eq!(parsed.target, ActTarget::Ref("@e1".to_owned()));
    }

    #[test]
    fn non_foreground_policies_block_raw_input() {
        let parsed = parse_act_request(&json!({"lookId":"look_1","action":"typeText","policy":"ax_only","target":{"ref":"@e1"},"params":{"text":"x"}})).unwrap();
        let err = policy_allows_raw_input(&parsed).unwrap_err();
        assert_eq!(err.code, ErrorCode::CoordinateBlocked);
        let background = parse_act_request(&json!({"lookId":"look_1","action":"click","policy":"background","target":{"x":1,"y":1},"params":{}})).unwrap();
        assert_eq!(
            policy_allows_raw_input(&background).unwrap_err().code,
            ErrorCode::ForegroundRequired
        );
        let default_policy = parse_act_request(&json!({"lookId":"look_1","action":"click","policy":"default","target":{"x":1,"y":1},"params":{}})).unwrap();
        assert_eq!(
            policy_allows_raw_input(&default_policy).unwrap_err().code,
            ErrorCode::ForegroundRequired
        );
        let foreground = parse_act_request(&json!({"lookId":"look_1","action":"click","policy":"foreground","target":{"x":1,"y":1},"params":{}})).unwrap();
        assert!(policy_allows_raw_input(&foreground).is_ok());
    }

    #[test]
    fn raw_input_refusals_do_not_dispatch() {
        for policy in ["default", "background", "ax_only", "invalid"] {
            for action in [
                "click",
                "scroll",
                "setText",
                "typeText",
                "keypress",
                "drag",
                "moveMouse",
            ] {
                let expected = if policy == "ax_only" {
                    ErrorCode::CoordinateBlocked
                } else {
                    ErrorCode::ForegroundRequired
                };
                let args = json!({"lookId":"look_1","action":action,"policy":policy,
                    "target":{"x":1,"y":2},"resolvedPoint":{"x":1,"y":2},"params":{"text":"explicit text","keys":["enter"],"path":[{"x":0,"y":0}],"scrollY":1}});
                let mut delivered = false;
                let error = act_with(&args, |_, _, _| {
                    delivered = true;
                    Ok(json!({"outcome":"unknown"}))
                })
                .unwrap_err();
                assert!(!delivered, "refused input must not reach delivery");
                assert_eq!(error.code, expected, "{policy}/{action}");
            }
            // Raw keyboard/motion actions must also refuse without resolvedPoint.
            for action in ["typeText", "keypress", "drag", "moveMouse"] {
                let args = json!({"lookId":"look_1","action":action,"policy":policy,"target":{"ref":"@e1"}});
                assert!(
                    act_with(&args, |_, _, _| panic!("refused input reached delivery")).is_err()
                );
            }
        }
    }

    #[test]
    fn attaches_delta_source_and_delta() {
        let out = response_with_delta(
            json!({"outcome":"worked","performed":{}}),
            "snapshot",
            vec![json!({"change":"focused","kind":"window","pid":1})],
        );
        assert_eq!(out["performed"]["deltaSource"], "snapshot");
        assert_eq!(out["rootDelta"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn raw_coordinate_actions_reach_delivery_after_preflight() {
        let actions = ["click", "moveMouse", "scroll", "typeText", "keypress"];
        for action in actions {
            let params = match action {
                "typeText" => json!({"text":"abc"}),
                "keypress" => json!({"keys":["enter"]}),
                "scroll" => json!({"scrollY":1,"scrollX":0}),
                _ => json!({}),
            };
            let result = act_with(&json!({"lookId":"look_1","action":action,"policy":"foreground","target":{"x":1,"y":1},"params":params,"resolvedPoint":{"x":1,"y":1}}), |request, _, grounding| {
                assert_eq!(request.action, action);
                assert_eq!(grounding, "coordinates");
                Ok(json!({"outcome":"unknown"}))
            }).unwrap();
            assert_ne!(
                result["outcome"], "worked",
                "{action} must not report worked without verification"
            );
        }
    }
}
