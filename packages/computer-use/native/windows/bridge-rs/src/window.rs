//! Window discovery on Windows.
//!
//! On Windows this module enumerates top-level visible windows, extracts
//! metadata (title, PID, process name, bounds, focus state), classifies
//! known browsers, and returns the results with window refs scoped to a
//! fresh state ID.
//!
//! On non-Windows platforms all entry points return a deterministic
//! `unsupported_platform` error.

use serde_json::Value;
#[cfg(windows)]
use std::collections::{HashMap, VecDeque};
#[cfg(windows)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(windows)]
use std::sync::{Mutex, OnceLock};

use crate::error::{ErrorCode, ProtocolError};
use crate::refs::RefStore;

#[cfg(windows)]
use crate::refs::NativeHandle;
#[cfg(any(windows, test))]
use crate::state::StateId;
#[cfg(any(windows, test))]
use serde_json::json;

// ---------------------------------------------------------------------------
// Browser classification  (cross-platform)
// ---------------------------------------------------------------------------

/// Classify a process name as one of the known browser families.
///
/// Returns `(is_browser, browser_family)` where `browser_family` is one of
/// `"chrome"`, `"edge"`, `"brave"`, or `None`.
///
/// Matching is case-insensitive and strips the `.exe` suffix when present.
pub fn classify_browser(process_name: &str) -> (bool, Option<&'static str>) {
    // Example inputs:  "chrome.exe", "msedge.exe", "NOTEPAD.EXE", "firefox"
    let lower = process_name.to_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    match stem {
        "chrome" | "chromium" => (true, Some("chrome")),
        "msedge" | "edge" => (true, Some("edge")),
        "brave" | "brave-browser" => (true, Some("brave")),
        "firefox" => (true, Some("firefox")),
        "vivaldi" => (true, Some("vivaldi")),
        "opera" | "opera_gx" => (true, Some("opera")),
        _ => (false, None),
    }
}

// ---------------------------------------------------------------------------
// Window enumeration
// ---------------------------------------------------------------------------

/// Enumerate visible top-level windows and return a JSON response value.
///
/// On non-Windows this always returns `UnsupportedPlatform`.
/// On Windows it enumerates visible top-level windows, inserts their native
/// handles into `store`, and returns a fresh stateId along with per-window
/// metadata.
///
/// If `filter_pid` is `Some(pid)`, only windows belonging to the given
/// process are returned. When `filter_pid` is `None`, all visible windows
/// are enumerated (used by the TypeScript `listApps` fallback).
pub fn list_windows(store: &mut RefStore, filter_pid: Option<u64>) -> Result<Value, ProtocolError> {
    #[cfg(not(windows))]
    {
        let _ = store; // unused on non-Windows
        let _ = filter_pid;
        Err(ProtocolError::new(
            "Window discovery is only supported on Windows",
            ErrorCode::UnsupportedPlatform,
        ))
    }

    #[cfg(windows)]
    {
        list_windows_impl(store, filter_pid)
    }
}

// ---------------------------------------------------------------------------
// Windows-specific implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
use std::{thread, time::Duration};
#[cfg(windows)]
use windows::core::PWSTR;
#[cfg(windows)]
use windows::Win32::Foundation::{
    CloseHandle, BOOL, ERROR_INSUFFICIENT_BUFFER, HANDLE, HWND, LPARAM, RECT, TRUE,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
#[cfg(windows)]
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
#[cfg(windows)]
use windows::Win32::UI::HiDpi::GetDpiForWindow;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow, GetMessageW, GetPropW, GetWindow,
    GetWindowLongPtrW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, SetForegroundWindow, SetPropW, EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY,
    EVENT_OBJECT_HIDE, EVENT_SYSTEM_FOREGROUND, GA_ROOT, GWL_EXSTYLE, GW_OWNER, MSG,
    WINEVENT_OUTOFCONTEXT, WS_EX_DLGMODALFRAME,
};

#[cfg(windows)]
const ROOT_EVENT_CAPACITY: usize = 256;

#[cfg(windows)]
#[derive(Clone)]
struct JournalEvent {
    sequence: u64,
    pid: u64,
    payload: Value,
}

#[cfg(windows)]
#[derive(Default)]
struct RootEventJournal {
    events: VecDeque<JournalEvent>,
    roots: HashMap<isize, Value>,
}

#[cfg(windows)]
fn event_journal() -> &'static Mutex<RootEventJournal> {
    static JOURNAL: OnceLock<Mutex<RootEventJournal>> = OnceLock::new();
    JOURNAL.get_or_init(|| Mutex::new(RootEventJournal::default()))
}

#[cfg(windows)]
fn event_sequence() -> &'static AtomicU64 {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    &SEQUENCE
}

/// Start the WinEvent message pump used as an acceleration and transient-root
/// journal. Final root snapshots remain authoritative.
pub fn start_root_event_journal() {
    #[cfg(windows)]
    std::thread::spawn(|| unsafe {
        let foreground = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(root_event_callback),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        let objects = SetWinEventHook(
            EVENT_OBJECT_CREATE,
            EVENT_OBJECT_HIDE,
            None,
            Some(root_event_callback),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        if foreground.is_invalid() && objects.is_invalid() {
            return;
        }
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {}
    });
}

pub fn root_event_cursor() -> u64 {
    #[cfg(windows)]
    {
        event_sequence().load(Ordering::Acquire)
    }
    #[cfg(not(windows))]
    {
        0
    }
}

pub fn root_events_since(cursor: u64, pid: u64) -> Vec<Value> {
    #[cfg(windows)]
    {
        event_journal()
            .lock()
            .map(|journal| {
                journal
                    .events
                    .iter()
                    .filter(|event| event.sequence > cursor && event.pid == pid)
                    .map(|event| event.payload.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        let _ = (cursor, pid);
        Vec::new()
    }
}

#[cfg(windows)]
unsafe extern "system" fn root_event_callback(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object_id: i32,
    child_id: i32,
    _thread: u32,
    _time: u32,
) {
    if hwnd.0.is_null() || (event != EVENT_SYSTEM_FOREGROUND && (object_id != 0 || child_id != 0)) {
        return;
    }
    if event != EVENT_OBJECT_DESTROY && GetAncestor(hwnd, GA_ROOT) != hwnd {
        return;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return;
    }
    let raw = hwnd.0 as isize;
    let mut journal = match event_journal().lock() {
        Ok(journal) => journal,
        Err(_) => return,
    };
    let change = match event {
        EVENT_OBJECT_DESTROY | EVENT_OBJECT_HIDE => "closed",
        EVENT_SYSTEM_FOREGROUND => "focused",
        _ => "appeared",
    };
    let root = if change == "closed" {
        journal.roots.remove(&raw).unwrap_or_else(|| {
            json!({
                "kind": "window", "title": "", "pid": pid, "windowId": raw
            })
        })
    } else {
        let root = event_root_payload(hwnd, pid);
        journal.roots.insert(raw, root.clone());
        root
    };
    let sequence = event_sequence().fetch_add(1, Ordering::AcqRel) + 1;
    let payload = json!({
        "change": change,
        "kind": root.get("kind").and_then(Value::as_str).unwrap_or("window"),
        "title": root.get("title").and_then(Value::as_str).unwrap_or(""),
        "pid": pid,
        "isModal": root.get("isModal").and_then(Value::as_bool).unwrap_or(false),
        "metadata": root.get("metadata").cloned().unwrap_or_else(|| json!({}))
    });
    journal.events.push_back(JournalEvent {
        sequence,
        pid: u64::from(pid),
        payload,
    });
    while journal.events.len() > ROOT_EVENT_CAPACITY {
        journal.events.pop_front();
    }
}

#[cfg(windows)]
unsafe fn event_root_payload(hwnd: HWND, pid: u32) -> Value {
    let class_name = get_window_class(hwnd);
    let title = get_window_title(hwnd);
    let owner = GetWindow(hwnd, GW_OWNER).ok();
    let kind = if class_name == "#32768" {
        "menu"
    } else if class_name == "#32770" {
        "dialog"
    } else if owner.map(|owner| !owner.0.is_null()).unwrap_or(false) {
        "popover"
    } else {
        "window"
    };
    let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    json!({
        "kind": kind,
        "title": title,
        "pid": pid,
        "windowId": hwnd.0 as isize,
        "isModal": class_name == "#32770" || (ex_style & WS_EX_DLGMODALFRAME.0) != 0,
        "metadata": { "className": class_name, "exStyle": ex_style }
    })
}

#[cfg(windows)]
unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let handles = &mut *(lparam.0 as *mut Vec<HWND>);
    handles.push(hwnd);
    TRUE
}

#[cfg(windows)]
unsafe fn get_window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut buf);
    if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    }
}

#[cfg(windows)]
unsafe fn get_window_class(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buf);
    if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    }
}

#[cfg(any(windows, test))]
enum QueryError {
    InsufficientBuffer,
    Unavailable,
}

/// Read the UTF-16 image path with at most one bounded retry. Length excludes the NUL.
#[cfg(any(windows, test))]
fn query_process_path(
    mut query: impl FnMut(&mut [u16]) -> Result<usize, QueryError>,
) -> Option<String> {
    let mut initial = [0u16; 260];
    match query(&mut initial) {
        Ok(len) => initial.get(..len).map(String::from_utf16_lossy),
        Err(QueryError::InsufficientBuffer) => {
            let mut extended = vec![0u16; 32_767];
            let len = query(&mut extended).ok()?;
            extended.get(..len).map(String::from_utf16_lossy)
        }
        Err(QueryError::Unavailable) => None,
    }
}

#[cfg(windows)]
unsafe fn get_process_name_by_pid(pid: u32) -> String {
    let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
        Ok(handle) => handle,
        Err(_) => return String::new(),
    };

    let path = query_process_path(|buf| {
        let mut size = buf.len() as u32;
        // SAFETY: the handle stays open and buf is writable for size UTF-16 units.
        // On success the API returns the length excluding the NUL; the caller checks it.
        let result = unsafe {
            QueryFullProcessImageNameW(
                handle,
                Default::default(),
                PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
        };
        match result {
            Ok(()) => Ok(size as usize),
            Err(err)
                if err.code()
                    == windows::core::HRESULT::from_win32(ERROR_INSUFFICIENT_BUFFER.0) =>
            {
                Err(QueryError::InsufficientBuffer)
            }
            Err(_) => Err(QueryError::Unavailable),
        }
    });
    let _ = CloseHandle(handle);

    let full_path = path.unwrap_or_default();
    std::path::Path::new(&full_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or(full_path)
}

#[cfg(windows)]
unsafe fn get_window_bounds_json(hwnd: HWND) -> Value {
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return json!({ "x": 0, "y": 0, "width": 0, "height": 0 });
    }
    json!({
        "x": rect.left,
        "y": rect.top,
        "width": rect.right - rect.left,
        "height": rect.bottom - rect.top,
    })
}

#[cfg(windows)]
fn list_windows_impl(
    store: &mut RefStore,
    filter_pid: Option<u64>,
) -> Result<Value, ProtocolError> {
    let mut hwnds: Vec<HWND> = Vec::new();
    unsafe {
        EnumWindows(
            Some(enum_windows_proc),
            LPARAM(&mut hwnds as *mut Vec<HWND> as isize),
        )
        .map_err(|e| {
            ProtocolError::new(format!("EnumWindows failed: {e}"), ErrorCode::InternalError)
        })?;
    }

    let foreground = unsafe { GetForegroundWindow() };
    let mut windows_info = Vec::new();

    for hwnd in hwnds {
        if !unsafe { IsWindowVisible(hwnd).as_bool() } {
            continue;
        }

        let title = unsafe { get_window_title(hwnd) };
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }

        if let Some(requested_pid) = filter_pid {
            if u64::from(pid) != requested_pid {
                continue;
            }
        }

        let process_name = if pid != 0 {
            unsafe { get_process_name_by_pid(pid) }
        } else {
            String::new()
        };
        let bounds = unsafe { get_window_bounds_json(hwnd) };
        let class_name = unsafe { get_window_class(hwnd) };
        let (is_browser, browser_family) = classify_browser(&process_name);
        // A root is bound only to an instance admitted for its listed owner. The ref
        // is per instance, so a replacement reusing this HWND gets a new ref.
        let (bound, generation) = match admit_window_instance(hwnd.0 as isize) {
            Some(instance) if instance.pid == u64::from(pid) => (true, instance.token),
            _ => (false, 0),
        };
        let wref = store.insert_window(NativeHandle::new(hwnd.0 as isize), generation);
        let dpi = unsafe { GetDpiForWindow(hwnd) };
        let scale_factor = if dpi > 0 { f64::from(dpi) / 96.0 } else { 1.0 };
        let owner = unsafe { GetWindow(hwnd, GW_OWNER).ok() };
        let is_minimized = unsafe { IsIconic(hwnd).as_bool() };
        let kind = if class_name == "#32768" {
            "menu"
        } else if class_name == "#32770" {
            "dialog"
        } else if owner.map(|hwnd| !hwnd.0.is_null()).unwrap_or(false) {
            "popover"
        } else {
            "window"
        };
        let role = if kind == "menu" { "Menu" } else { "Window" };
        let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        let is_modal = class_name == "#32770" || (ex_style & WS_EX_DLGMODALFRAME.0) != 0;

        windows_info.push(json!({
            "kind": kind,
            "rootRef": wref.to_string(),
            "windowRef": wref.to_string(),
            "ref": wref.to_string(),
            "windowId": hwnd.0 as isize,
            "title": title,
            "pid": pid,
            "appName": process_name.trim_end_matches(".exe"),
            "processName": process_name,
            "role": role,
            "subrole": class_name,
            "zOrder": windows_info.len(),
            "framePoints": bounds,
            "bounds": bounds,
            "scaleFactor": scale_factor,
            "isFocused": hwnd == foreground,
            "isMain": hwnd == foreground,
            "isMinimized": is_minimized,
            "isOnscreen": !is_minimized,
            "isModal": is_modal,
            "metadata": { "className": class_name, "exStyle": ex_style, "isBrowser": is_browser, "browserFamily": browser_family },
            "isBrowser": is_browser,
            "browserFamily": browser_family,
            "instanceUnavailable": !bound,
        }));
    }

    Ok(window_list_response(windows_info))
}

/// Serialize an enumeration without requiring an interactive desktop in tests.
#[cfg(any(windows, test))]
fn window_list_response(windows_info: Vec<Value>) -> Value {
    json!({
        "stateId": StateId::fresh("w"),
        "windows": windows_info,
        "roots": windows_info,
    })
}

/// Return the current owner of this exact HWND, or `None` if it no longer exists.
pub fn owner_pid(hwnd: isize) -> Option<u64> {
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        None
    }
    #[cfg(windows)]
    {
        let mut pid = 0u32;
        // SAFETY: Windows validates the borrowed HWND and only writes to this local PID.
        let thread = unsafe { GetWindowThreadProcessId(HWND(hwnd as *mut _), Some(&mut pid)) };
        (thread != 0 && pid != 0).then_some(u64::from(pid))
    }
}

/// Window property naming the helper's instance tag on a discovered window.
///
/// Windows frees a window's properties when it is destroyed, so a replacement window
/// that reuses the exact HWND value never carries the tag of the window it replaced.
#[cfg(windows)]
pub const INSTANCE_PROPERTY: windows::core::PCWSTR =
    windows::core::w!("PiComputerUseWindowInstance-v1");

/// One live window instance: its owning PID, that process's creation time and the
/// helper's instance tag. Equal HWND and PID values with a different tag or process
/// creation time are a different window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowInstance {
    pub pid: u64,
    pub process_started: u64,
    pub token: usize,
}

/// Return the live instance of `hwnd` without tagging it, or `None` when the owner,
/// its creation time or the instance tag cannot be verified.
pub fn window_instance(hwnd: isize) -> Option<WindowInstance> {
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        None
    }
    #[cfg(windows)]
    {
        sample_instance(|| owner_pid(hwnd), process_started, || instance_token(hwnd))
    }
}

/// Tag `hwnd` with an instance token unless it already carries one, then return its
/// instance. `None` when the tag cannot be written and confirmed, so the caller must
/// refuse the window rather than admit it unbound.
///
/// Admissions in this helper are serialized, so two concurrent first admissions of
/// one window never overwrite each other's tag. Separate helper processes are not
/// serialized against each other (see the README limits).
pub fn admit_window_instance(hwnd: isize) -> Option<WindowInstance> {
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        None
    }
    #[cfg(windows)]
    {
        use std::hash::BuildHasher;
        static MINTED: AtomicU64 = AtomicU64::new(0);
        static ADMISSION: Mutex<()> = Mutex::new(());
        // Held across the read, write and read-back so a concurrent first admission
        // reads this tag instead of writing its own over it.
        let _serial = ADMISSION.lock().ok()?;
        let nonce = std::collections::hash_map::RandomState::new()
            .hash_one(MINTED.fetch_add(1, Ordering::Relaxed)) as usize;
        ensure_instance_token(
            || instance_token(hwnd),
            // SAFETY: SetPropW validates the borrowed HWND; the tag is an opaque value, never dereferenced.
            |token| unsafe {
                SetPropW(
                    HWND(hwnd as *mut _),
                    INSTANCE_PROPERTY,
                    HANDLE(token as *mut _),
                )
                .is_ok()
            },
            nonce.max(1),
        )?;
        window_instance(hwnd)
    }
}

/// Return `outcome` only while `hwnd` is still exactly the `admitted` instance.
///
/// Sample the instance AFTER the live call that produced `outcome`: a refusal or
/// result seen across a replacement (or a closed window) reports `root_stale`
/// instead. Pass `Ok(())` for a bare check. Never pass a mutation's outcome; a
/// performed or uncertain mutation must not be relabelled.
pub fn ensure_instance<T>(
    hwnd: isize,
    admitted: WindowInstance,
    outcome: Result<T, ProtocolError>,
) -> Result<T, ProtocolError> {
    if window_instance(hwnd) == Some(admitted) {
        outcome
    } else {
        Err(unverified_instance(true))
    }
}

/// Message of the refusal for an admitted window that is gone or replaced; UIA
/// helpers return it as a string error and callers map it back to `root_stale`.
pub const STALE_INSTANCE: &str =
    "Target window is no longer the admitted instance; rediscover it with find_roots";

/// The `root_stale` refusal for a window that is not provably its admitted instance:
/// `admitted` names a verified root that went stale, otherwise discovery could never
/// bind it (its owner, process start or instance tag was unreadable).
pub fn unverified_instance(admitted: bool) -> ProtocolError {
    ProtocolError::new(
        if admitted {
            STALE_INSTANCE
        } else {
            "Target window could not be admitted: its owner, process start or instance tag is unverifiable, so it cannot be observed or controlled"
        },
        ErrorCode::RootStale,
    )
}

/// Read an instance, requiring the same owner before and after the process and tag reads.
#[cfg(any(windows, test))]
fn sample_instance(
    mut owner: impl FnMut() -> Option<u64>,
    started: impl FnOnce(u64) -> Option<u64>,
    token: impl FnOnce() -> Option<usize>,
) -> Option<WindowInstance> {
    let pid = owner()?;
    let instance = WindowInstance {
        pid,
        process_started: started(pid)?,
        token: token()?,
    };
    (owner()? == pid).then_some(instance)
}

/// Keep an existing tag, or write `minted` and return the tag read back afterwards.
#[cfg(any(windows, test))]
fn ensure_instance_token(
    mut read: impl FnMut() -> Option<usize>,
    write: impl FnOnce(usize) -> bool,
    minted: usize,
) -> Option<usize> {
    if let Some(token) = read() {
        return Some(token);
    }
    // A concurrent helper may win the write; its tag still names this instance.
    write(minted).then(read)?
}

/// Read this window's instance tag; zero means untagged, closed or unreadable.
#[cfg(windows)]
fn instance_token(hwnd: isize) -> Option<usize> {
    // SAFETY: GetPropW validates the borrowed HWND and returns an opaque value.
    let token = unsafe { GetPropW(HWND(hwnd as *mut _), INSTANCE_PROPERTY) }.0 as usize;
    (token != 0).then_some(token)
}

/// Return the creation time of process `pid`, which changes when the PID is reused.
#[cfg(windows)]
fn process_started(pid: u64) -> Option<u64> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetProcessTimes;
    let pid = u32::try_from(pid).ok()?;
    // SAFETY: the handle stays open for the query and is closed on every path; the
    // FILETIME outputs are local.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut times = [FILETIME::default(); 4];
        let [created, exited, kernel, user] = &mut times;
        let queried = GetProcessTimes(process, created, exited, kernel, user);
        let _ = CloseHandle(process);
        queried.ok()?;
        let started =
            (u64::from(times[0].dwHighDateTime) << 32) | u64::from(times[0].dwLowDateTime);
        (started != 0).then_some(started)
    }
}

pub fn foreground_pid() -> Option<u64> {
    #[cfg(not(windows))]
    {
        None
    }
    #[cfg(windows)]
    {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        (pid != 0).then_some(u64::from(pid))
    }
}

pub fn focus_window(
    store: &RefStore,
    target_ref: &crate::refs::WindowRef,
) -> Result<Value, ProtocolError> {
    #[cfg(not(windows))]
    {
        let _ = store;
        let _ = target_ref;
        Err(ProtocolError::new(
            "Window focus is only supported on Windows",
            ErrorCode::UnsupportedPlatform,
        ))
    }

    #[cfg(windows)]
    {
        let native = store.get_window(target_ref).ok_or_else(|| {
            ProtocolError::new(
                format!("Window ref '{}' not found", target_ref),
                ErrorCode::TargetNotFound,
            )
        })?;
        let hwnd = HWND(native.raw() as *mut _);
        // SAFETY: GetForegroundWindow returns a borrowed handle used only for comparison.
        let already_focused = unsafe { GetForegroundWindow() == hwnd };
        request_foreground(native.raw())?;
        Ok(json!({ "focused": true, "alreadyFocused": already_focused }))
    }
}

/// Read-only foreground admission. Only explicit focus/capture may raise/restore.
pub fn ensure_foreground(hwnd: isize) -> Result<(), ProtocolError> {
    crate::desktop::validated_bounds(hwnd, None)?;
    #[cfg(windows)]
    {
        // SAFETY: borrowed validated HWND; this only observes current focus.
        if unsafe { GetForegroundWindow() } == HWND(hwnd as *mut _) {
            return Ok(());
        }
    }
    Err(ProtocolError::new(
        "Explicit focus and fresh observation required",
        ErrorCode::ForegroundRequired,
    ))
}

/// Explicit focus/capture transition, including one paired Alt hint if needed.
/// The caller must hold the shared physical-input lease. Action preflight uses
/// `ensure_foreground` instead, so stale/occluded refs never send an Alt hint.
pub fn request_foreground(hwnd: isize) -> Result<(), ProtocolError> {
    foreground_impl(hwnd, true)
}

fn foreground_impl(hwnd: isize, allow_input_hint: bool) -> Result<(), ProtocolError> {
    #[cfg(not(windows))]
    {
        let _ = (hwnd, allow_input_hint);
        Err(ProtocolError::new(
            "Window focus is only supported on Windows",
            ErrorCode::UnsupportedPlatform,
        ))
    }
    #[cfg(windows)]
    {
        crate::desktop::validated_bounds(hwnd, None)?;
        let target = HWND(hwnd as *mut _);
        // SW_RESTORE is idempotent, unlike taskbar toggles or SW_SHOW.
        // SAFETY: IsIconic borrows the validated HWND and retains no pointers.
        if unsafe { windows::Win32::UI::WindowsAndMessaging::IsIconic(target).as_bool() } {
            // SAFETY: target is a validated borrowed HWND; SW_RESTORE is a documented command.
            let _ = unsafe {
                windows::Win32::UI::WindowsAndMessaging::ShowWindow(
                    target,
                    windows::Win32::UI::WindowsAndMessaging::SW_RESTORE,
                )
            };
        }
        // SAFETY: foreground queries return borrowed handles used only for comparison.
        if unsafe { GetForegroundWindow() != target } {
            // SAFETY: SetForegroundWindow borrows the validated HWND; success is verified below.
            let _ = unsafe { SetForegroundWindow(target) };
            // SAFETY: no pointers are retained by this foreground query.
            if allow_input_hint && unsafe { GetForegroundWindow() != target } {
                // Windows documents Alt as releasing the foreground lock.
                // The complete explicit transition remains under the caller's
                // shared physical-input lease, including paired key cleanup.
                crate::input::foreground_hint()?;
                // SAFETY: target remains a borrowed HWND; the API reports a vanished/refused target.
                unsafe { windows::Win32::UI::WindowsAndMessaging::BringWindowToTop(target) }
                    .map_err(|_| {
                        ProtocolError::uncertain(
                            "Windows refused to raise the target after a focus attempt",
                            ErrorCode::TargetNotFound,
                        )
                    })?;
            }
        }
        for _ in 0..4 {
            // SAFETY: the foreground handle is borrowed and only compared.
            if unsafe { GetForegroundWindow() == target } {
                return Ok(());
            }
            // SAFETY: the API borrows target; a vanished HWND is refused by the final query.
            let _ = unsafe { SetForegroundWindow(target) };
            thread::sleep(Duration::from_millis(20));
        }
        // SAFETY: final foreground verification retains no handles or pointers.
        if unsafe { GetForegroundWindow() == target } {
            Ok(())
        } else {
            Err(ProtocolError::uncertain(
                "Windows foreground transition could not be verified",
                ErrorCode::TargetNotFound,
            ))
        }
    }
}

/// Refuse physical screen points not owned by the selected foreground window.
#[cfg(windows)]
pub fn ensure_point_owned(hwnd: isize, point: &Value) -> Result<(), ProtocolError> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};
    let refused = || {
        ProtocolError::new(
            "Screen point ownership could not be verified",
            ErrorCode::OccludedTarget,
        )
    };
    let x = point.get("x").and_then(Value::as_f64).ok_or_else(refused)?;
    let y = point.get("y").and_then(Value::as_f64).ok_or_else(refused)?;
    if !x.is_finite()
        || !y.is_finite()
        || x < f64::from(i32::MIN)
        || x > f64::from(i32::MAX)
        || y < f64::from(i32::MIN)
        || y > f64::from(i32::MAX)
    {
        return Err(refused());
    }
    let target = HWND(hwnd as *mut _);
    // SAFETY: WindowFromPoint and GetAncestor accept borrowed handles/points.
    let owned = unsafe {
        GetForegroundWindow() == target
            && GetAncestor(
                WindowFromPoint(POINT {
                    x: x.round() as i32,
                    y: y.round() as i32,
                }),
                GA_ROOT,
            ) == target
    };
    if owned {
        Ok(())
    } else {
        Err(refused())
    }
}

/// Non-Windows builds cannot admit physical ownership.
#[cfg(not(windows))]
pub fn ensure_point_owned(_hwnd: isize, _point: &Value) -> Result<(), ProtocolError> {
    Err(ProtocolError::new(
        "Physical ownership requires Windows",
        ErrorCode::UnsupportedPlatform,
    ))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod unit_tests {
    #[test]
    fn image_path_retries_once_with_larger_buffer() {
        let mut capacities = Vec::new();
        let path = query_process_path(|buf| {
            capacities.push(buf.len());
            if buf.len() == 260 {
                return Err(QueryError::InsufficientBuffer);
            }
            buf[..261].fill(u16::from(b'x'));
            Ok(261)
        });
        assert_eq!(path, Some("x".repeat(261)));
        assert_eq!(capacities, [260, 32_767]);
    }

    #[test]
    fn image_path_succeeds_without_retry() {
        let mut calls = 0;
        let path = query_process_path(|buf| {
            calls += 1;
            buf[0] = u16::from(b'x');
            Ok(1)
        });
        assert_eq!(path.as_deref(), Some("x"));
        assert_eq!(calls, 1);
    }

    #[test]
    fn image_path_does_not_retry_access_denied() {
        let mut calls = 0;
        assert_eq!(
            query_process_path(|_| {
                calls += 1;
                Err(QueryError::Unavailable)
            }),
            None
        );
        assert_eq!(calls, 1);
    }

    #[test]
    fn image_path_refuses_invalid_reported_length() {
        assert_eq!(query_process_path(|buf| Ok(buf.len() + 1)), None);
        assert_eq!(
            query_process_path(|buf| if buf.len() == 260 {
                Err(QueryError::InsufficientBuffer)
            } else {
                Ok(buf.len() + 1)
            }),
            None
        );
    }

    #[test]
    fn image_path_stops_at_maximum_capacity() {
        let mut capacities = Vec::new();
        assert_eq!(
            query_process_path(|buf| {
                capacities.push(buf.len());
                Err(QueryError::InsufficientBuffer)
            }),
            None
        );
        assert_eq!(capacities, [260, 32_767]);
    }

    use super::*;
    #[cfg(not(windows))]
    use crate::error::ErrorCode;

    // -- Window instance identity (cross-platform seams) ---------------------

    #[test]
    fn instance_samples_require_every_part_and_a_stable_owner() {
        let sample = |owners: [Option<u64>; 2], started: Option<u64>, token: Option<usize>| {
            let mut owners = owners.into_iter();
            let mut queried = Vec::new();
            let instance = sample_instance(
                || owners.next().unwrap(),
                |pid| {
                    queried.push(pid);
                    started
                },
                || token,
            );
            (instance, queried)
        };
        let instance = WindowInstance {
            pid: 7,
            process_started: 70,
            token: 700,
        };
        assert_eq!(
            sample([Some(7), Some(7)], Some(70), Some(700)),
            (Some(instance), vec![7])
        );
        assert_eq!(sample([None, Some(7)], Some(70), Some(700)), (None, vec![]));
        for (owners, started, token) in [
            ([Some(7), Some(7)], None, Some(700)),
            ([Some(7), Some(7)], Some(70), None),
            ([Some(7), Some(8)], Some(70), Some(700)),
            ([Some(7), None], Some(70), Some(700)),
        ] {
            assert_eq!(sample(owners, started, token), (None, vec![7]));
        }
    }

    #[test]
    fn instance_tags_are_kept_or_written_and_confirmed() {
        let tag = |reads: &[Option<usize>], written: bool| {
            let mut reads = reads.iter().copied();
            let mut writes = Vec::new();
            let token = ensure_instance_token(
                || reads.next().unwrap(),
                |minted| {
                    writes.push(minted);
                    written
                },
                42,
            );
            (token, writes)
        };
        assert_eq!(tag(&[Some(9)], true), (Some(9), vec![]), "keep a tag");
        assert_eq!(tag(&[None, Some(42)], true), (Some(42), vec![42]));
        // A concurrent helper's tag still names this instance.
        assert_eq!(tag(&[None, Some(43)], true), (Some(43), vec![42]));
        assert_eq!(tag(&[None], false), (None, vec![42]), "write refused");
        assert_eq!(tag(&[None, None], true), (None, vec![42]), "not confirmed");
    }

    #[test]
    #[cfg(not(windows))]
    fn window_instances_are_never_verified_off_windows() {
        assert_eq!(window_instance(1), None);
        assert_eq!(admit_window_instance(1), None);
        let admitted = WindowInstance {
            pid: 1,
            process_started: 1,
            token: 1,
        };
        // A refusal seen after the window went away reports the lost instance.
        let refused = ensure_instance(
            1,
            admitted,
            Err::<(), _>(ProtocolError::new("blocked", ErrorCode::CoordinateBlocked)),
        )
        .unwrap_err();
        assert_eq!(refused.code, ErrorCode::RootStale);
        assert_eq!(refused.message, STALE_INSTANCE);
        assert_eq!(
            ensure_instance(1, admitted, Ok(5)).unwrap_err().code,
            ErrorCode::RootStale
        );
    }

    #[test]
    fn instance_refusals_tell_unadmitted_roots_from_stale_ones() {
        let stale = unverified_instance(true);
        let unadmitted = unverified_instance(false);
        assert_eq!(
            (stale.code, unadmitted.code),
            (ErrorCode::RootStale, ErrorCode::RootStale)
        );
        assert_eq!(stale.message, STALE_INSTANCE);
        assert!(unadmitted.message.contains("could not be admitted"));
    }

    /// Real Win32 instance tags on a message-only window owned by this test process.
    #[test]
    #[cfg(windows)]
    fn window_instances_tag_live_windows_and_refuse_destroyed_ones() {
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, RemovePropW, HWND_MESSAGE, WINDOW_EX_STYLE,
            WINDOW_STYLE,
        };
        // SAFETY: the predefined STATIC class needs no registration; the window is
        // owned by this thread and destroyed below.
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("instance tag fixture"),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                None,
                None,
                None,
            )
        }
        .expect("create a message-only window");
        let raw = hwnd.0 as isize;
        assert_eq!(
            window_instance(raw),
            None,
            "untagged windows are unverified"
        );
        let admitted = admit_window_instance(raw).expect("tag an owned window");
        assert_eq!(admitted.pid, u64::from(std::process::id()));
        assert_ne!(admitted.process_started, 0);
        assert_eq!(window_instance(raw), Some(admitted));
        assert_eq!(admit_window_instance(raw), Some(admitted), "keep the tag");
        assert_eq!(ensure_instance(raw, admitted, Ok(5)).unwrap(), 5);
        // A refusal while the admitted instance is still live is kept as is.
        let blocked = ProtocolError::new("blocked", ErrorCode::CoordinateBlocked);
        assert_eq!(
            ensure_instance(raw, admitted, Err::<(), _>(blocked))
                .unwrap_err()
                .code,
            ErrorCode::CoordinateBlocked
        );
        let replaced = WindowInstance {
            token: admitted.token.wrapping_add(1),
            ..admitted
        };
        assert_eq!(
            ensure_instance(raw, replaced, Ok(())).unwrap_err().code,
            ErrorCode::RootStale
        );
        assert_eq!(process_started(u64::from(u32::MAX) + 1), None);
        // SAFETY: this thread owns the window; the removed value is an opaque tag.
        unsafe {
            RemovePropW(hwnd, INSTANCE_PROPERTY).expect("remove the instance tag");
        }
        assert_eq!(
            ensure_instance(raw, admitted, Ok(())).unwrap_err().code,
            ErrorCode::RootStale,
            "same HWND and PID without the tag is a different instance"
        );
        // Concurrent first admissions of one window agree on a single tag.
        let admissions = std::thread::scope(|scope| {
            let workers = (0..8)
                .map(|_| scope.spawn(move || admit_window_instance(raw)))
                .collect::<Vec<_>>();
            workers
                .into_iter()
                .map(|worker| worker.join().expect("admission thread"))
                .collect::<Vec<_>>()
        });
        let live = window_instance(raw).expect("one admitted tag");
        assert!(admissions.iter().all(|admitted| *admitted == Some(live)));
        // SAFETY: this thread created the window and destroys it exactly once.
        unsafe { DestroyWindow(hwnd) }.expect("destroy the fixture window");
        assert_eq!(window_instance(raw), None);
        assert_eq!(
            admit_window_instance(raw),
            None,
            "closed windows refuse tags"
        );
    }

    // -- Browser classification (cross-platform) ----------------------------

    #[test]
    fn test_classify_browser_chrome_exe() {
        let (is_browser, family) = classify_browser("chrome.exe");
        assert!(is_browser);
        assert_eq!(family, Some("chrome"));
    }

    #[test]
    fn test_classify_browser_chromium_exe() {
        let (is_browser, family) = classify_browser("chromium.exe");
        assert!(is_browser);
        assert_eq!(family, Some("chrome"));
    }

    #[test]
    fn test_classify_browser_chrome_no_ext() {
        // Some process names may not include .exe
        let (is_browser, family) = classify_browser("chrome");
        assert!(is_browser);
        assert_eq!(family, Some("chrome"));
    }

    #[test]
    fn test_classify_browser_edge_exe() {
        let (is_browser, family) = classify_browser("msedge.exe");
        assert!(is_browser);
        assert_eq!(family, Some("edge"));
    }

    #[test]
    fn test_classify_browser_edge_no_ext() {
        let (is_browser, family) = classify_browser("edge");
        assert!(is_browser);
        assert_eq!(family, Some("edge"));
    }

    #[test]
    fn test_classify_browser_brave_exe() {
        let (is_browser, family) = classify_browser("brave.exe");
        assert!(is_browser);
        assert_eq!(family, Some("brave"));
    }

    #[test]
    fn test_classify_browser_brave_browser_exe() {
        let (is_browser, family) = classify_browser("brave-browser.exe");
        assert!(is_browser);
        assert_eq!(family, Some("brave"));
    }

    #[test]
    fn test_classify_browser_not_a_browser() {
        let (is_browser, family) = classify_browser("notepad.exe");
        assert!(!is_browser);
        assert_eq!(family, None);
    }

    #[test]
    fn test_classify_browser_empty_string() {
        let (is_browser, family) = classify_browser("");
        assert!(!is_browser);
        assert_eq!(family, None);
    }

    #[test]
    fn test_classify_browser_case_insensitive() {
        let (is_browser, family) = classify_browser("CHROME.EXE");
        assert!(is_browser);
        assert_eq!(family, Some("chrome"));
    }

    // -- Platform support check (non-Windows) -------------------------------

    #[test]
    #[cfg(not(windows))]
    fn test_list_windows_unsupported_platform() {
        let mut store = RefStore::new();
        let result = list_windows(&mut store, None);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code, ErrorCode::UnsupportedPlatform);
    }

    // -- JSON result shape --------------------------------------------------

    #[test]
    fn test_list_windows_response_preserves_the_enumerated_roots() {
        // Synthetic metadata, not enumeration of the CI worker's desktop.
        let windows = vec![json!({"ref":"@w1", "windowId":42, "title":"Fixture"})];
        let response = window_list_response(windows.clone());
        assert_eq!(response["windows"], json!(windows));
        assert_eq!(response["roots"], response["windows"]);
        assert!(response["stateId"].as_str().unwrap().starts_with("w-"));
    }

    // -- Window refs and state IDs are fresh (Windows-only) -----------------

    #[test]
    fn test_list_windows_produces_unique_state_ids() {
        let result_a = window_list_response(vec![]);
        let result_b = window_list_response(vec![]);

        let id_a = result_a["stateId"].as_str().unwrap().to_owned();
        let id_b = result_b["stateId"].as_str().unwrap().to_owned();
        assert_ne!(
            id_a, id_b,
            "each listWindows call must produce a fresh stateId"
        );
    }

    #[test]
    fn test_list_windows_window_ref_prefix() {
        let mut store = RefStore::new();
        let reference = store.insert_window(crate::refs::NativeHandle::new(42), 0);
        let result = window_list_response(vec![json!({"ref":reference.to_string()})]);
        if let Some(windows) = result["windows"].as_array() {
            for w in windows {
                let wref = w["ref"].as_str().unwrap();
                assert!(
                    wref.starts_with("@w"),
                    "window ref must start with @w, got {wref}"
                );
            }
        }
    }
}
