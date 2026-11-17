//! Real Win32/UIA tests, confined to a disposable window owned by this process.
//! These are Windows execution proof, not WSL interop or owner-desktop acceptance.
#[cfg(windows)]
mod native {

    use base64::Engine as _;
    use serde_json::{json, Value};
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };
    use std::time::Duration;
    use windows::core::w;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows_bridge::desktop::{validated_bounds, PhysicalLease};
    use windows_bridge::refs::{NativeHandle, RefStore};
    use windows_bridge::uia::{live_elements, press, snapshot, PressResult};

    static CLICKS: AtomicUsize = AtomicUsize::new(0);

    /// Drive the actual sibling release executable over its production NDJSON pipe.
    struct HelperClient {
        child: Child,
        stdin: ChildStdin,
        frames: mpsc::Receiver<Value>,
        next_id: usize,
    }

    impl HelperClient {
        fn new() -> Self {
            let example = std::env::current_exe().expect("fixture executable path");
            let helper = example
                .parent()
                .and_then(|dir| dir.parent())
                .expect("release examples directory")
                .join("windows-bridge.exe");
            let mut child = Command::new(helper)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("run actual built native helper");
            let stdin = child.stdin.take().expect("native stdin");
            let stdout = child.stdout.take().expect("native stdout");
            let (sender, frames) = mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let line = line.expect("read native frame");
                    let frame = serde_json::from_str(&line).expect("parse native frame");
                    if sender.send(frame).is_err() {
                        break;
                    }
                }
            });
            Self {
                child,
                stdin,
                frames,
                next_id: 0,
            }
        }

        fn request(&mut self, cmd: &str, args: Value) -> Value {
            self.next_id += 1;
            let id = format!("fixture-{}", self.next_id);
            writeln!(
                self.stdin,
                "{}",
                json!({"protocolVersion":4,"id":id,"cmd":cmd,"args":args})
            )
            .expect("write native request");
            self.stdin.flush().expect("flush native request");
            let frame = self
                .frames
                .recv_timeout(Duration::from_secs(5))
                .expect("actual helper must return within the fixture deadline");
            assert_eq!(frame["id"], id);
            assert_eq!(frame["protocolVersion"], 4);
            frame
        }

        fn success(&mut self, cmd: &str, args: Value) -> Value {
            let frame = self.request(cmd, args);
            assert_eq!(frame["ok"], true, "native request failed: {frame}");
            frame["result"].clone()
        }
    }

    impl Drop for HelperClient {
        fn drop(&mut self) {
            // Only this disposable child is stopped, never any owner process.
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn label_ref(node: &Value) -> Option<String> {
        if node["title"] == "Unread message complete disposable label"
            && node["ref"]
                .as_str()
                .is_some_and(|reference| reference.starts_with("win:"))
        {
            return node["ref"].as_str().map(str::to_owned);
        }
        node["children"].as_array()?.iter().find_map(label_ref)
    }

    unsafe extern "system" fn fixture_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_LBUTTONUP {
            CLICKS.fetch_add(1, Ordering::SeqCst);
        }
        if message == WM_GETOBJECT
            && windows::Win32::UI::Accessibility::UiaClientsAreListening().as_bool()
        {
            // A real provider-side assistive-client dependency, without touching
            // SPI_SETSCREENREADER or exposing any owner application's state.
            let _ = SetWindowTextW(hwnd, w!("Unread message complete disposable label"));
        }
        if message == WM_PAINT || message == WM_PRINTCLIENT {
            use windows::Win32::Foundation::{COLORREF, RECT};
            use windows::Win32::Graphics::Gdi::*;
            let mut paint = PAINTSTRUCT::default();
            let dc = if message == WM_PAINT {
                BeginPaint(hwnd, &mut paint)
            } else {
                HDC(wparam.0 as *mut _)
            };
            let first = CreateSolidBrush(COLORREF(0x004080c0));
            let second = CreateSolidBrush(COLORREF(0x00c08040));
            FillRect(
                dc,
                &RECT {
                    left: 0,
                    top: 0,
                    right: 180,
                    bottom: 40,
                },
                first,
            );
            FillRect(
                dc,
                &RECT {
                    left: 180,
                    top: 0,
                    right: 360,
                    bottom: 40,
                },
                second,
            );
            let _ = DeleteObject(HGDIOBJ(first.0));
            let _ = DeleteObject(HGDIOBJ(second.0));
            if message == WM_PAINT {
                let _ = EndPaint(hwnd, &paint);
            }
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    struct Fixture {
        hwnd: isize,
        child: isize,
        sentinel: isize,
    }

    impl Fixture {
        fn new() -> Self {
            let (sender, receiver) = mpsc::channel();
            std::thread::spawn(move || unsafe {
                // Only our new GUI thread creates/owns these disposable windows.
                let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                let instance = HINSTANCE(
                    windows::Win32::System::LibraryLoader::GetModuleHandleW(None)
                        .expect("fixture module")
                        .0,
                );
                let class = WNDCLASSW {
                    lpfnWndProc: Some(fixture_proc),
                    hInstance: instance,
                    lpszClassName: w!("PiDisposableNoninvokableFixture"),
                    ..Default::default()
                };
                assert_ne!(
                    RegisterClassW(&class),
                    0,
                    "register disposable fixture class"
                );
                let root = CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("STATIC"),
                    w!("Disposable native helper fixture"),
                    WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                    100,
                    100,
                    500,
                    300,
                    None,
                    None,
                    None,
                    None,
                )
                .expect("create fixture root");
                let child = CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("PiDisposableNoninvokableFixture"),
                    w!("Awaiting scoped assistive-client discovery"),
                    WS_CHILD | WS_VISIBLE,
                    20,
                    50,
                    360,
                    40,
                    root,
                    None,
                    instance,
                    None,
                )
                .expect("create fixture label");
                // Hidden until the refusal test needs a deterministic, owned foreground.
                let sentinel = CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("STATIC"),
                    w!("Disposable foreground sentinel"),
                    WS_OVERLAPPEDWINDOW,
                    650,
                    100,
                    400,
                    250,
                    None,
                    None,
                    None,
                    None,
                )
                .expect("create owned foreground sentinel");
                sender
                    .send((root.0 as isize, child.0 as isize, sentinel.0 as isize))
                    .expect("send fixture identity");
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                    if !IsWindow(root).as_bool() {
                        break;
                    }
                }
            });
            let (hwnd, child, sentinel) = receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("disposable interactive fixture unavailable");
            Self {
                hwnd,
                child,
                sentinel,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // No owner application is targeted; both disposable roots are ours.
            let _ = unsafe {
                PostMessageW(
                    HWND(self.sentinel as *mut _),
                    WM_CLOSE,
                    WPARAM(0),
                    LPARAM(0),
                )
            };
            let _ =
                unsafe { PostMessageW(HWND(self.hwnd as *mut _), WM_CLOSE, WPARAM(0), LPARAM(0)) };
        }
    }

    pub fn run() -> i32 {
        use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
        use windows::Win32::System::StationsAndDesktops::*;
        use windows::Win32::System::Threading::GetCurrentProcessId;
        let mut session = 0;
        unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) }
            .expect("query real fixture session");
        if session == 0 {
            eprintln!("NATIVE_FIXTURE_UNSUPPORTED: session 0 is a noninteractive service session");
            return 3;
        }
        match unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) } {
            Ok(input) => {
                unsafe { CloseDesktop(input) }.expect("close preflight desktop handle");
            }
            Err(error) if error.code() == windows::Win32::Foundation::E_ACCESSDENIED => {
                eprintln!("NATIVE_FIXTURE_UNSUPPORTED: OpenInputDesktop denied access to the interactive desktop");
                return 3;
            }
            Err(error) => panic!("unexpected input-desktop preflight failure: {error}"),
        }
        let mut screen_reader_before = windows::Win32::Foundation::BOOL(0);
        unsafe {
            SystemParametersInfoW(
                SPI_GETSCREENREADER,
                0,
                Some((&mut screen_reader_before as *mut windows::Win32::Foundation::BOOL).cast()),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        }
        .expect("read owner accessibility state");
        let fixture = Fixture::new();
        let bounds = validated_bounds(fixture.hwnd, Some(u64::from(std::process::id()))).expect(
            "Production access validation failed on the preflight-verified interactive context",
        );
        assert!(bounds.width > 0.0 && bounds.height > 0.0);
        println!("NATIVE_DPI_OBSERVED: {}", unsafe {
            windows::Win32::UI::HiDpi::GetDpiForWindow(HWND(fixture.hwnd as *mut _))
        });
        println!(
            "NATIVE_MIXED_DPI_NEGATIVE_MONITOR_NOT_RUN: requires authorized multi-monitor desktop"
        );
        assert!(validated_bounds(0, None).is_err());
        assert!(validated_bounds(fixture.hwnd, Some(u64::MAX)).is_err());

        let elements = live_elements(fixture.hwnd).expect("read actual UIA provider");
        let mut screen_reader_after = windows::Win32::Foundation::BOOL(0);
        unsafe {
            SystemParametersInfoW(
                SPI_GETSCREENREADER,
                0,
                Some((&mut screen_reader_after as *mut windows::Win32::Foundation::BOOL).cast()),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        }
        .expect("re-read owner accessibility state");
        assert_eq!(
            screen_reader_before, screen_reader_after,
            "scoped discovery preserves global screen-reader state"
        );
        let label = elements
            .iter()
            .find(|element| element["label"] == "Unread message complete disposable label")
            .expect("read full label without clicking");
        let identity = label["runtimeId"]
            .as_array()
            .expect("runtime identity")
            .iter()
            .map(|value| value.as_i64().expect("identity integer") as i32)
            .collect::<Vec<_>>();
        let automation_id = label["automationId"].as_str().unwrap_or("");
        assert!(matches!(
            press(fixture.hwnd, &identity, automation_id).expect("probe patterns"),
            PressResult::NoPattern
        ));
        assert!(
            windows_bridge::uia::focus_for_input(fixture.hwnd, &identity, automation_id, true)
                .is_err(),
            "a noneditable label cannot receive text fallback"
        );
        assert!(
            snapshot(fixture.hwnd, &identity, &format!("{automation_id}-changed")).is_err(),
            "an observed AutomationId is an additional identity constraint, not a locator"
        );
        let before = snapshot(fixture.hwnd, &identity, automation_id).expect("current rect");
        unsafe {
            SetWindowPos(
                HWND(fixture.child as *mut _),
                None,
                20,
                100,
                360,
                40,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
        }
        .expect("move only fixture label");
        let after = snapshot(fixture.hwnd, &identity, automation_id)
            .expect("fresh rect after layout shift");
        assert_eq!(after.rect.1 - before.rect.1, 50.0);
        assert!(
            snapshot(fixture.hwnd, &[i32::MAX], automation_id).is_err(),
            "AutomationId must not revive a stale RuntimeId"
        );

        let fixture_input = PhysicalLease::acquire().expect("own explicit fixture focus/capture");
        windows_bridge::window::request_foreground(fixture.hwnd)
            .expect("foreground disposable fixture");
        drop(fixture_input);
        let mut helper = HelperClient::new();
        let diagnostics = helper.success("diagnostics", json!({}));
        assert_eq!(
            diagnostics["capabilities"],
            json!(["fail-closed-live-target-v1"])
        );
        helper.success("listRoots", json!({"pid":std::process::id()}));
        let look = helper.success(
            "look",
            json!({"windowId":fixture.hwnd,"includeImage":false}),
        );
        let actual_ref =
            label_ref(&look["outline"]).expect("actual helper discovers full owned label");
        let act_args = json!({"lookId":look["lookId"],"action":"click","policy":"foreground","target":{"ref":actual_ref},"params":{}});
        let click = helper.success("act", act_args.clone());
        assert_eq!(
            click["performed"]["delivery"], "hid",
            "non-invokable control must use the production fallback"
        );
        let mut cursor_before = windows::Win32::Foundation::POINT::default();
        // SAFETY: initialized writable POINT, read-only desktop observation.
        unsafe { GetCursorPos(&mut cursor_before) }.expect("cursor before refused drag");
        let foreground_before = unsafe { GetForegroundWindow() };
        let mut attack = act_args.clone();
        attack["action"] = json!("drag");
        attack["params"] = json!({"path":[{"x":2.0,"y":2.0}]});
        attack["resolvedPath"] = json!([{"x":0,"y":0},{"x":100000,"y":100000}]);
        attack["resolvedPoint"] = json!({"x":100000,"y":100000});
        assert_eq!(helper.request("act", attack)["ok"], false);
        let mut cursor_after = windows::Win32::Foundation::POINT::default();
        unsafe { GetCursorPos(&mut cursor_after) }.expect("cursor after refused drag");
        assert_eq!(
            (cursor_before.x, cursor_before.y),
            (cursor_after.x, cursor_after.y)
        );
        assert_eq!(unsafe { GetForegroundWindow() }, foreground_before);
        let fixture_input = PhysicalLease::acquire().expect("resume owned fixture capture tests");
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while CLICKS.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            CLICKS.load(Ordering::SeqCst),
            1,
            "only the disposable current target receives input"
        );
        assert!(
            unsafe { ShowWindow(HWND(fixture.hwnd as *mut _), SW_MINIMIZE) }.as_bool(),
            "fixture was visible before minimization"
        );
        assert!(
            unsafe { IsIconic(HWND(fixture.hwnd as *mut _)) }.as_bool(),
            "fixture must actually be minimized before restore"
        );
        windows_bridge::window::request_foreground(fixture.hwnd)
            .expect("restore fixture idempotently");
        windows_bridge::window::request_foreground(fixture.hwnd)
            .expect("repeat restore must not toggle minimized");
        assert!(!unsafe { IsIconic(HWND(fixture.hwnd as *mut _)) }.as_bool());
        let mut store = RefStore::new();
        let reference = store.insert_window(NativeHandle::new(fixture.hwnd));
        assert!(unsafe { ShowWindow(HWND(fixture.hwnd as *mut _), SW_MINIMIZE) }.as_bool());
        assert!(
            unsafe { IsIconic(HWND(fixture.hwnd as *mut _)) }.as_bool(),
            "capture must start from an actually minimized fixture"
        );
        let capture = windows_bridge::capture::screenshot(
            &mut store,
            &reference,
            false,
            Some(400),
            u64::from(std::process::id()),
        )
        .expect("fresh selected-window capture");
        assert!(
            capture["capture"]["imageBase64"]
                .as_str()
                .expect("PNG bytes")
                .len()
                > 100
        );
        assert!(
            !unsafe { IsIconic(HWND(fixture.hwnd as *mut _)) }.as_bool(),
            "selected-window capture restores its own minimized target"
        );
        assert!(capture["capture"]["width"].as_u64().expect("width") <= 400);
        let png = base64::engine::general_purpose::STANDARD
            .decode(
                capture["capture"]["imageBase64"]
                    .as_str()
                    .expect("PNG base64"),
            )
            .expect("decode actual captured PNG bytes");
        let image = image::load_from_memory(&png)
            .expect("read back actual native window capture")
            .into_rgba8();
        let live =
            snapshot(fixture.hwnd, &identity, automation_id).expect("current painted label rect");
        let x = ((live.rect.0 - capture["capture"]["x"].as_f64().expect("capture x") + 90.0)
            * f64::from(image.width())
            / capture["capture"]["sourceWidth"]
                .as_f64()
                .expect("source width")) as u32;
        let y = ((live.rect.1 - capture["capture"]["y"].as_f64().expect("capture y") + 20.0)
            * f64::from(image.height())
            / capture["capture"]["sourceHeight"]
                .as_f64()
                .expect("source height")) as u32;
        assert_eq!(
            image.get_pixel(x, y).0,
            [192, 128, 64, 255],
            "selected window's own painted content must survive capture/read-back"
        );
        unsafe {
            PostMessageW(
                HWND(fixture.child as *mut _),
                WM_CLOSE,
                WPARAM(0),
                LPARAM(0),
            )
        }
        .expect("remove only the owned fixture control");
        let removal_deadline = std::time::Instant::now() + Duration::from_secs(1);
        while unsafe { IsWindow(HWND(fixture.child as *mut _)) }.as_bool()
            && std::time::Instant::now() < removal_deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !unsafe { IsWindow(HWND(fixture.child as *mut _)) }.as_bool(),
            "fixture control must actually be removed"
        );
        assert!(
            snapshot(fixture.hwnd, &identity, automation_id).is_err(),
            "removed UIA identity cannot resolve inside the retained window"
        );
        // A stale ref must not even restore/foreground its surviving minimized owner.
        let _ = unsafe { ShowWindow(HWND(fixture.hwnd as *mut _), SW_MINIMIZE) };
        assert!(unsafe { IsIconic(HWND(fixture.hwnd as *mut _)) }.as_bool());
        let _ = unsafe { ShowWindow(HWND(fixture.sentinel as *mut _), SW_SHOW) };
        windows_bridge::window::request_foreground(fixture.sentinel)
            .expect("activate only the owned foreground sentinel");
        let foreground_before = unsafe { GetForegroundWindow() };
        assert_eq!(
            foreground_before,
            HWND(fixture.sentinel as *mut _),
            "no transient HWND0 baseline"
        );
        assert!(unsafe { IsIconic(HWND(fixture.hwnd as *mut _)) }.as_bool());
        drop(fixture_input);
        let stale = helper.request("act", act_args);
        assert_eq!(
            stale["ok"], false,
            "actual helper must refuse its removed target"
        );
        assert_eq!(stale["error"]["code"], "stale_ref");
        assert!(
            unsafe { IsIconic(HWND(fixture.hwnd as *mut _)) }.as_bool(),
            "stale refusal must not restore"
        );
        assert_eq!(
            unsafe { GetForegroundWindow() },
            foreground_before,
            "stale refusal must not foreground"
        );
        assert_eq!(
            CLICKS.load(Ordering::SeqCst),
            1,
            "removed target cannot replay the earlier click"
        );
        drop(helper);

        println!("NATIVE_FIXTURE_PASS: scoped assistive-client labels, pattern probe, current layout bounds, actual click, restore, PNG read-back, PID refusals");
        0
    }
}

/// Run only against an explicitly authorized disposable Windows desktop.
fn main() {
    #[cfg(windows)]
    std::process::exit(native::run());
    #[cfg(not(windows))]
    {
        eprintln!("NATIVE_FIXTURE_UNSUPPORTED: Windows execution required");
        std::process::exit(3);
    }
}
