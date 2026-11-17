//! Real Win32/UIA tests, confined to a disposable window owned by this process.
//! These are Windows execution proof, not WSL interop or owner-desktop acceptance.
#[cfg(windows)]
mod native {

    use base64::Engine as _;
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
                sender
                    .send((root.0 as isize, child.0 as isize))
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
            let (hwnd, child) = receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("disposable interactive fixture unavailable");
            Self { hwnd, child }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // No owner application is targeted; our window thread destroys its root.
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
        {
            let _lease = PhysicalLease::acquire().expect("own physical click");
            let window = validated_bounds(fixture.hwnd, Some(u64::from(std::process::id())))
                .expect("live fixture window");
            windows_bridge::guard::deliver_to_live_target(
                &identity, window,
                || {
                    let live = snapshot(fixture.hwnd, &identity, automation_id).map_err(|message| windows_bridge::ProtocolError::new(message, windows_bridge::ErrorCode::StaleRef))?;
                    Ok(windows_bridge::guard::LiveTarget { runtime_id: live.runtime_id, bounds: windows_bridge::guard::Bounds { x: live.rect.0, y: live.rect.1, width: live.rect.2, height: live.rect.3 } })
                },
                |x,y| windows_bridge::uia::occlusion_ok(fixture.hwnd, &identity, automation_id, x,y).map_err(|message| windows_bridge::ProtocolError::new(message, windows_bridge::ErrorCode::OccludedTarget)),
                |x,y| windows_bridge::input::act(&serde_json::json!({ "lookId":"fixture", "action":"click", "policy":"foreground", "target":{"x":0,"y":0}, "resolvedPoint":{"x":x,"y":y}, "params":{} })),
            ).expect("deliver one native non-invokable fixture click");
        }
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
        let delivered = std::cell::Cell::new(false);
        let stale: Result<(), windows_bridge::ProtocolError> =
            windows_bridge::guard::deliver_to_live_target(
                &identity,
                validated_bounds(fixture.hwnd, Some(u64::from(std::process::id())))
                    .expect("retained fixture window"),
                || {
                    let current =
                        snapshot(fixture.hwnd, &identity, automation_id).map_err(|message| {
                            windows_bridge::ProtocolError::new(
                                message,
                                windows_bridge::ErrorCode::StaleRef,
                            )
                        })?;
                    Ok(windows_bridge::guard::LiveTarget {
                        runtime_id: current.runtime_id,
                        bounds: windows_bridge::guard::Bounds {
                            x: current.rect.0,
                            y: current.rect.1,
                            width: current.rect.2,
                            height: current.rect.3,
                        },
                    })
                },
                |_, _| Ok(true),
                |_, _| {
                    delivered.set(true);
                    Ok(())
                },
            );
        assert!(stale.is_err());
        assert!(!delivered.get(), "real UIA removal must deliver zero input");
        assert_eq!(
            CLICKS.load(Ordering::SeqCst),
            1,
            "removed target cannot replay the earlier click"
        );
        drop(fixture_input);

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
