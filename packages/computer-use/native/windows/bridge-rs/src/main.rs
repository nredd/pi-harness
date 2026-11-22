use std::cell::Cell;
use std::collections::{hash_map::RandomState, HashMap, VecDeque};
use std::hash::BuildHasher;
use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::{self, sleep};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows_bridge::{
    capture, input,
    protocol::PROTOCOL_VERSION,
    refs::{NativeHandle, RefStore},
    window,
    window::WindowInstance,
    ErrorCode, ProtocolError, Request, Response,
};

#[derive(Clone, Debug)]
struct ElementRecord {
    hwnd: isize,
    automation_id: String,
    is_secure: bool,
    runtime_id: Vec<i32>,
}

#[derive(Clone, Debug)]
struct LookRecord {
    pid: u64,
    hwnd: isize,
    /// The window instance this look observed; every later use must find it live.
    instance: WindowInstance,
    frame_x: f64,
    frame_y: f64,
    frame_w: f64,
    frame_h: f64,
    image_w: f64,
    image_h: f64,
    has_image: bool,
    elements: HashMap<String, ElementRecord>,
}

impl LookRecord {
    /// Return the element this look issued as `reference`.
    fn element(&self, reference: &str) -> Result<ElementRecord, ProtocolError> {
        self.elements
            .get(reference)
            .cloned()
            .ok_or_else(|| ProtocolError::new("Element reference is stale", ErrorCode::StaleRef))
    }
}

#[derive(Clone, Debug)]
struct RootSnapshot {
    roots: HashMap<String, Value>,
    foreground_pid: Option<u64>,
}

struct HelperState {
    store: RefStore,
    roots: HashMap<String, Value>,
    /// Each saved root's HWND and the window instance its root ref was issued for,
    /// keyed by that ref; `None` when discovery could not admit the window.
    root_instances: HashMap<String, (isize, Option<WindowInstance>)>,
    looks: HashMap<String, LookRecord>,
    look_order: VecDeque<String>,
    look_generation: u64,
    next_look: u64,
}

const MAX_LOOK_RECORDS: usize = 8;
const REQUEST_WORKERS: usize = 8;
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
static INPUT_CLOSED: AtomicBool = AtomicBool::new(false);

impl Default for HelperState {
    fn default() -> Self {
        // RandomState is randomly keyed; the counter alone restarts at 1.
        Self::from_entropy(&RandomState::new())
    }
}

impl HelperState {
    /// Key this helper lifetime's look generation with `entropy`.
    fn from_entropy(entropy: &impl BuildHasher) -> Self {
        Self::new(entropy.hash_one(std::process::id()))
    }

    fn new(look_generation: u64) -> Self {
        Self {
            store: RefStore::new(),
            roots: HashMap::new(),
            root_instances: HashMap::new(),
            looks: HashMap::new(),
            look_order: VecDeque::new(),
            look_generation,
            next_look: 1,
        }
    }

    fn fresh_look_id(&mut self) -> String {
        let look_id = format!("look_{:016x}_{}", self.look_generation, self.next_look);
        self.next_look += 1;
        look_id
    }

    /// Replace the saved roots (all, or only `filter_pid`'s) with `discovered` and bind
    /// each root ref to the live window instance `read` reports, but only if discovery
    /// issued that ref for this instance of its listed PID. Any other root stays listed
    /// but unbound, so every later use refuses it.
    fn save_roots(
        &mut self,
        filter_pid: Option<u64>,
        discovered: Vec<Value>,
        mut read: impl FnMut(isize) -> Option<WindowInstance>,
    ) {
        if let Some(pid) = filter_pid {
            let root_instances = &mut self.root_instances;
            self.roots.retain(|_, root| {
                let keep = root.get("pid").and_then(Value::as_u64) != Some(pid);
                if let Some(root_ref) = root.get("rootRef").and_then(Value::as_str) {
                    if !keep {
                        root_instances.remove(root_ref);
                    }
                }
                keep
            });
        } else {
            self.store.retain_window_refs(
                discovered
                    .iter()
                    .filter_map(|root| root.get("rootRef").and_then(Value::as_str)),
            );
            self.roots.clear();
            self.root_instances.clear();
        }
        for root in discovered {
            if let (Some(hwnd), Some(root_ref)) = (
                root.get("windowId").and_then(Value::as_i64),
                root.get("rootRef").and_then(Value::as_str),
            ) {
                let hwnd = hwnd as isize;
                let pid = root.get("pid").and_then(Value::as_u64);
                // The ref names (HWND, tag); a window replaced since enumeration maps
                // to another ref, so it never binds to this one.
                let instance = read(hwnd).filter(|instance| {
                    Some(instance.pid) == pid
                        && self
                            .store
                            .insert_window(NativeHandle::new(hwnd), instance.token)
                            .to_string()
                            == root_ref
                });
                self.root_instances
                    .insert(root_ref.to_owned(), (hwnd, instance));
            }
            self.roots.insert(root_identity(&root), root);
        }
    }

    fn insert_look(&mut self, look_id: String, record: LookRecord) {
        self.looks.insert(look_id.clone(), record);
        self.look_order.push_back(look_id);
        while self.look_order.len() > MAX_LOOK_RECORDS {
            if let Some(expired) = self.look_order.pop_front() {
                self.looks.remove(&expired);
            }
        }
    }
}

fn helper_state() -> &'static Mutex<HelperState> {
    static STATE: OnceLock<Mutex<HelperState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HelperState::default()))
}

fn physical_input_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

thread_local! { static IN_PHYSICAL_TRANSACTION: Cell<bool> = const { Cell::new(false) }; }

fn with_physical_input<T>(
    work: impl FnOnce() -> Result<T, ProtocolError>,
) -> Result<T, ProtocolError> {
    if INPUT_CLOSED.load(Ordering::Acquire) {
        return Err(cancelled());
    }
    if IN_PHYSICAL_TRANSACTION.with(Cell::get) {
        return work();
    }
    let _guard = physical_input_lock()
        .lock()
        .map_err(|_| internal("physical input lock poisoned"))?;
    let _host_lease = windows_bridge::desktop::PhysicalLease::acquire()?;
    if INPUT_CLOSED.load(Ordering::Acquire) {
        return Err(cancelled());
    }
    IN_PHYSICAL_TRANSACTION.with(|flag| flag.set(true));
    let result = work();
    IN_PHYSICAL_TRANSACTION.with(|flag| flag.set(false));
    result
}

/// Cancel admission and let an active physical operation clean up first.
/// A stuck provider still forces a bounded stop with the host lease retained.
fn terminate_without_ack(deadline: Instant) -> ! {
    INPUT_CLOSED.store(true, Ordering::Release);
    let _ = wait_for_input_cleanup(physical_input_lock(), deadline);
    std::process::exit(3);
}

fn wait_for_input_cleanup(lock: &Mutex<()>, deadline: Instant) -> bool {
    loop {
        match lock.try_lock() {
            Ok(_) | Err(std::sync::TryLockError::Poisoned(_)) => return true,
            Err(std::sync::TryLockError::WouldBlock) => {}
        }
        if Instant::now() >= deadline {
            return false;
        }
        sleep(Duration::from_millis(10));
    }
}

fn main() {
    #[cfg(windows)]
    if !set_dpi_awareness() {
        eprintln!("Per-monitor-v2 DPI awareness could not be established; refusing helper startup");
        std::process::exit(2);
    }
    window::start_root_event_journal();

    let stdin = io::stdin();
    let (sender, receiver) = mpsc::channel::<Request>();
    let receiver = Arc::new(Mutex::new(receiver));
    let workers = (0..REQUEST_WORKERS)
        .map(|_| {
            let receiver = Arc::clone(&receiver);
            thread::spawn(move || loop {
                let request = match receiver.lock() {
                    Ok(receiver) => receiver.recv(),
                    Err(_) => return,
                };
                match request {
                    Ok(request) => {
                        // EOF cancels queued mutations. Cheap read-only diagnostics
                        // still drain, preserving one-shot readiness probes.
                        if INPUT_CLOSED.load(Ordering::Acquire) && !matches!(request.cmd.as_str(), "diagnostics" | "listRoots" | "listWindows") { continue; }
                        let response = handle_request(&request);
                        if response.error.as_ref().is_some_and(ProtocolError::outcome_uncertain) {
                            let _ = writeln!(io::stderr().lock(), "Mutating input outcome uncertain; terminating without acknowledgement or replay");
                            terminate_without_ack(Instant::now() + SHUTDOWN_GRACE);
                        }
                        emit_response(&response);
                    }
                    Err(_) => return,
                }
            })
        })
        .collect::<Vec<_>>();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                let resp = Response::err(
                    "unknown",
                    ProtocolError::new(
                        format!("Failed to read input line: {e}"),
                        ErrorCode::InternalError,
                    ),
                );
                emit_response(&resp);
                terminate_without_ack(Instant::now() + SHUTDOWN_GRACE);
            }
        };
        let trimmed = line.trim().to_owned();
        if trimmed.is_empty() {
            continue;
        }
        let id = extract_id(&trimmed).unwrap_or_else(|| "unknown".to_owned());
        let request: Request = match serde_json::from_str(&trimmed) {
            Ok(req) => req,
            Err(e) => {
                emit_response(&Response::err(
                    &id,
                    ProtocolError::new(format!("Invalid request: {e}"), ErrorCode::InvalidRequest),
                ));
                continue;
            }
        };
        if sender.send(request).is_err() {
            break;
        }
    }
    INPUT_CLOSED.store(true, Ordering::Release);
    drop(sender);
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while workers.iter().any(|worker| !worker.is_finished()) {
        if Instant::now() >= deadline {
            // A provider may be stuck in synchronous UIA/PrintWindow work.
            // Stop the process, never detach it or replay an uncertain action.
            terminate_without_ack(deadline);
        }
        sleep(Duration::from_millis(10));
    }
    for worker in workers {
        let _ = worker.join();
    }
}

#[cfg(windows)]
fn set_dpi_awareness() -> bool {
    use windows::Win32::UI::HiDpi::{
        AreDpiAwarenessContextsEqual, GetThreadDpiAwarenessContext, SetProcessDpiAwarenessContext,
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    // SAFETY: the constant is a documented DPI context; no pointers are borrowed.
    if let Err(error) =
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
    {
        // A manifest may already have established the required context. Verify it below.
        eprintln!("SetProcessDpiAwarenessContext: {error}; verifying existing thread context");
    }
    // SAFETY: both context handles are borrowed values, used only for comparison.
    unsafe {
        AreDpiAwarenessContextsEqual(
            GetThreadDpiAwarenessContext(),
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        )
        .as_bool()
    }
}

fn extract_id(line: &str) -> Option<String> {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|v| v.get("id")?.as_str().map(String::from))
}

fn handle_request(request: &Request) -> Response {
    if request.protocol_version != PROTOCOL_VERSION {
        return Response::err(&request.id, ProtocolError::new(format!("Unsupported Windows helper protocol {}; expected {}. Restart Pi to use the installed helper.", request.protocol_version, PROTOCOL_VERSION), ErrorCode::InvalidRequest));
    }

    let result = match request.cmd.as_str() {
        "diagnostics" => Ok(diagnostics()),
        "listRoots" | "listWindows" => handle_list_roots(&request.args),
        "look" | "screenshot" => handle_look(&request.args),
        "focusWindow" => handle_focus_window(&request.args),
        "act" => handle_act(&request.args),
        "actBatch" => handle_act_batch(&request.args),
        "uiaReadText" | "axReadText" => handle_read_text(&request.args),
        "uiaWaitFor" | "axWaitFor" => handle_wait_for(&request.args),
        "openBrowserLocation" => handle_open_browser_location(&request.args),
        other => Err(ProtocolError::new(
            format!("Unknown command '{other}'"),
            ErrorCode::UnsupportedCommand,
        )),
    };

    match result {
        Ok(value) => Response::ok(&request.id, value),
        Err(error) => Response::err(&request.id, error),
    }
}

fn diagnostics() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "architectureVersion": 1,
        "capabilities": ["fail-closed-live-target-v1"],
        "invariants": ["state-scoped-observations", "bounded-observation-history", "multi-root-forest", "progressive-disclosure", "atomic-physical-input", "concurrent-requests", "transactional-batching"],
        "pid": std::process::id(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "accessibility": true,
        "screenRecording": true
    })
}

fn handle_list_roots(args: &Value) -> Result<Value, ProtocolError> {
    let filter_pid = args.get("pid").and_then(Value::as_u64);
    let mut state = helper_state()
        .lock()
        .map_err(|_| internal("helper state lock poisoned"))?;
    let result = window::list_windows(&mut state.store, filter_pid)?;
    state.save_roots(filter_pid, roots_array(&result), window::window_instance);
    Ok(result)
}

fn handle_focus_window(args: &Value) -> Result<Value, ProtocolError> {
    let root_ref = args
        .get("rootRef")
        .or_else(|| args.get("windowRef"))
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("focusWindow requires rootRef"))?;
    let wref = windows_bridge::refs::WindowRef::parse(root_ref)
        .ok_or_else(|| invalid(format!("Invalid root ref '{root_ref}'")))?;
    let (store, hwnd, instance) = {
        let state = helper_state()
            .lock()
            .map_err(|_| internal("helper state lock poisoned"))?;
        let root = state
            .roots
            .values()
            .find(|root| root.get("rootRef").and_then(Value::as_str) == Some(root_ref))
            .ok_or_else(|| ProtocolError::new("Focus root is stale", ErrorCode::StaleRef))?;
        let admitted = AdmittedRoot {
            hwnd: root.get("windowId").and_then(Value::as_i64).unwrap_or(0) as isize,
            pid: root.get("pid").and_then(Value::as_u64).unwrap_or(0),
        };
        let instance = admitted.admitted_instance(&state, None, Some(root_ref))?;
        (state.store.clone(), admitted.hwnd, instance)
    };
    with_physical_input(|| {
        // Checked after the lease wait: never raise a replacement reusing the HWND.
        window::ensure_instance(
            hwnd,
            instance,
            windows_bridge::desktop::validated_bounds(hwnd, Some(instance.pid)),
        )?;
        window::focus_window(&store, &wref)
    })
}

fn handle_look(args: &Value) -> Result<Value, ProtocolError> {
    let started_at = Instant::now();
    let root_ref = args
        .get("rootRef")
        .or_else(|| args.get("windowRef"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let window_id = args.get("windowId").and_then(Value::as_i64);
    let include_image = args
        .get("includeImage")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let max_dimension = args
        .get("maxDimension")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, 16_384) as u32);
    let read_text = args
        .get("readText")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    if !matches!(read_text, "auto" | "always" | "never") {
        return Err(invalid("readText must be auto, always, or never"));
    }
    let scope_ref = args
        .get("scopeRef")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let base_look_id = args.get("baseLookId").and_then(Value::as_str);

    if root_ref.is_none() && window_id.is_none() {
        return Err(invalid("look requires rootRef or windowId"));
    }

    let roots_missing = helper_state()
        .lock()
        .map_err(|_| internal("helper state lock poisoned"))?
        .roots
        .is_empty();
    if roots_missing {
        let _ = handle_list_roots(&json!({}));
    }
    let (mut store, identity, root, instance) = {
        let state = helper_state()
            .lock()
            .map_err(|_| internal("helper state lock poisoned"))?;
        let (identity, root) = state
            .roots
            .iter()
            .find(|(_, root)| {
                // An issued root ref denotes one window instance. Never widen it to
                // the HWND, whose latest discovery may be a replacement.
                root_ref.as_deref().is_none_or(|r| {
                    root.get("rootRef").and_then(Value::as_str) == Some(r)
                        || root.get("windowRef").and_then(Value::as_str) == Some(r)
                }) && window_id
                    .is_none_or(|id| root.get("windowId").and_then(Value::as_i64) == Some(id))
            })
            .ok_or_else(|| match root_ref {
                Some(_) => window::unverified_instance(true),
                None => ProtocolError::new("Root not found", ErrorCode::TargetNotFound),
            })?;
        // Observe only the instance this root ref was issued for.
        let instance = AdmittedRoot {
            hwnd: root.get("windowId").and_then(Value::as_i64).unwrap_or(0) as isize,
            pid: root.get("pid").and_then(Value::as_u64).unwrap_or(0),
        }
        .admitted_instance(&state, None, root.get("rootRef").and_then(Value::as_str))?;
        (
            state.store.clone(),
            identity.clone(),
            root.clone(),
            instance,
        )
    };

    let root_ref = root
        .get("rootRef")
        .and_then(Value::as_str)
        .unwrap_or(&identity)
        .to_owned();
    let root_hwnd = root.get("windowId").and_then(Value::as_i64).unwrap_or(0) as isize;
    // A closed or replaced window reports root_stale, not the desktop refusal.
    let live_frame = window::ensure_instance(
        root_hwnd,
        instance,
        windows_bridge::desktop::validated_bounds(root_hwnd, Some(instance.pid)),
    )?;
    let kind = root.get("kind").and_then(Value::as_str).unwrap_or("window");
    let is_outline_only = kind == "menu" || !include_image;
    #[cfg(not(windows))]
    let frame = root
        .get("framePoints")
        .cloned()
        .unwrap_or_else(|| json!({"x":0,"y":0,"w":1,"h":1}));
    #[cfg(not(windows))]
    let _ = live_frame;
    #[cfg(windows)]
    let frame =
        json!({"x":live_frame.x,"y":live_frame.y,"w":live_frame.width,"h":live_frame.height});
    let mut fx = number_at(&frame, "x", 0.0);
    let mut fy = number_at(&frame, "y", 0.0);
    let mut fw = number_at(&frame, "w", number_at(&frame, "width", 1.0)).max(1.0);
    let mut fh = number_at(&frame, "h", number_at(&frame, "height", 1.0)).max(1.0);

    #[cfg(not(windows))]
    let mut scale_factor = root
        .get("scaleFactor")
        .and_then(Value::as_f64)
        .unwrap_or(1.0);
    #[cfg(windows)]
    let mut scale_factor = {
        // SAFETY: GetDpiForWindow borrows the discovered HWND; zero is refused below.
        let dpi = unsafe {
            windows::Win32::UI::HiDpi::GetDpiForWindow(windows::Win32::Foundation::HWND(
                root.get("windowId").and_then(Value::as_i64).unwrap_or(0) as *mut _,
            ))
        };
        if dpi == 0 {
            return Err(ProtocolError::new(
                "Observed window DPI is unavailable",
                ErrorCode::TargetNotFound,
            ));
        }
        f64::from(dpi) / 96.0
    };
    let mut image_payload = None;
    let mut elements = Vec::new();
    let mut image_w = fw;
    let mut image_h = fh;

    let capture_started = Instant::now();
    if !is_outline_only {
        let wref = windows_bridge::refs::WindowRef::parse(&root_ref)
            .ok_or_else(|| invalid(format!("Invalid root ref '{root_ref}'")))?;
        let shot = with_physical_input(|| {
            // Rechecked after the lease wait, since capture may restore or raise the
            // window, and after capture, so no image of a replacement is returned.
            window::ensure_instance(
                root_hwnd,
                instance,
                windows_bridge::desktop::validated_bounds(root_hwnd, Some(instance.pid)),
            )?;
            window::ensure_instance(
                root_hwnd,
                instance,
                capture::screenshot(
                    &mut store,
                    &wref,
                    scope_ref.is_none(),
                    max_dimension,
                    instance.pid,
                ),
            )
        })?;
        if let Some(capture) = shot.get("capture") {
            fx = number_at(capture, "x", fx);
            fy = number_at(capture, "y", fy);
            fw = number_at(capture, "sourceWidth", fw);
            fh = number_at(capture, "sourceHeight", fh);
            scale_factor = number_at(capture, "scaleFactor", scale_factor);
            image_w = number_at(capture, "width", fw).max(1.0);
            image_h = number_at(capture, "height", fh).max(1.0);
            if let Some(encoded) = capture.get("imageBase64").and_then(Value::as_str) {
                image_payload = Some(
                    json!({ "jpegBase64": encoded, "mimeType": "image/png", "width": image_w, "height": image_h }),
                );
            }
        }
        elements = shot
            .get("axTargets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
    } else {
        #[cfg(windows)]
        {
            if let Some(wref) = windows_bridge::refs::WindowRef::parse(&root_ref) {
                if let Some(native) = store.get_window(&wref) {
                    elements = window::ensure_instance(
                        root_hwnd,
                        instance,
                        windows_bridge::uia::live_elements(native.raw())
                            .map_err(stale_ref_from_uia),
                    )?;
                }
            }
        }
    }

    let capture_ms = capture_started.elapsed().as_millis() as u64;
    let mut base_look = None;
    if let Some(scope_ref) = scope_ref.as_deref() {
        let (owning_look, scope) =
            look_record_for_element(scope_ref, base_look_id).ok_or_else(|| {
                ProtocolError::new(
                    "Scope ref is stale or outside the target root",
                    ErrorCode::StaleRef,
                )
            })?;
        if scope.hwnd != root_hwnd || owning_look.instance != instance {
            return Err(ProtocolError::new(
                "Scope ref is stale or outside the target root",
                ErrorCode::StaleRef,
            ));
        }
        elements = windows_bridge::uia::extract_elements_from(
            &mut store,
            scope.hwnd,
            instance,
            &scope.runtime_id,
            &scope.automation_id,
        )
        .map_err(stale_ref_from_uia)?;
        base_look = Some(owning_look);
    }
    // Discard elements captured across a replacement of the observed instance.
    window::ensure_instance(root_hwnd, instance, Ok(()))?;

    let look_id = fresh_look_id()?;
    let describe_started = Instant::now();
    let (mut outline, mut element_records) = outline_from_elements(
        scope_ref.as_deref().unwrap_or(&root_ref),
        &look_id,
        kind,
        &root,
        &elements,
        fx,
        fy,
        image_w,
        image_h,
        fw,
        fh,
    )?;
    if let Some(scope_ref) = scope_ref.as_deref() {
        outline = scoped_outline_root(outline, scope_ref);
    }
    if let Some(base) = base_look.as_ref() {
        element_records.extend(base.elements.clone());
    }
    let describe_ms = describe_started.elapsed().as_millis() as u64;
    let record = LookRecord {
        pid: root.get("pid").and_then(Value::as_u64).unwrap_or(0),
        hwnd: root_hwnd,
        instance,
        frame_x: base_look.as_ref().map(|look| look.frame_x).unwrap_or(fx),
        frame_y: base_look.as_ref().map(|look| look.frame_y).unwrap_or(fy),
        frame_w: base_look.as_ref().map(|look| look.frame_w).unwrap_or(fw),
        frame_h: base_look.as_ref().map(|look| look.frame_h).unwrap_or(fh),
        image_w: base_look
            .as_ref()
            .map(|look| look.image_w)
            .unwrap_or(image_w),
        image_h: base_look
            .as_ref()
            .map(|look| look.image_h)
            .unwrap_or(image_h),
        has_image: base_look
            .as_ref()
            .map(|look| look.has_image)
            .unwrap_or_else(|| image_payload.is_some()),
        elements: element_records,
    };
    store_look_record(look_id.clone(), record)?;

    let mut response = json!({
        "lookId": look_id,
        "capturedAt": now_seconds(),
        "window": {
            "windowId": root.get("windowId").and_then(Value::as_i64).unwrap_or(0),
            "rootRef": root_ref,
            "kind": kind,
            "framePoints": { "x": fx, "y": fy, "w": fw, "h": fh },
            "scaleFactor": scale_factor,
            "isModal": root.get("isModal").and_then(Value::as_bool).unwrap_or(false),
            "role": root.get("role").and_then(Value::as_str).unwrap_or("Window"),
            "subrole": root.get("subrole").and_then(Value::as_str).unwrap_or("")
        },
        "outline": outline,
        "timings": { "captureMs": capture_ms, "describeMs": describe_ms, "readTextMs": 0, "totalMs": started_at.elapsed().as_millis() as u64 },
        "readText": { "requested": read_text, "executed": false }
    });
    if let Some(metadata) = root.get("metadata") {
        response["window"]["metadata"] = metadata.clone();
    }
    if let Some(image) = image_payload {
        response["image"] = image;
    }
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
fn outline_from_elements(
    root_ref: &str,
    look_id: &str,
    kind: &str,
    root: &Value,
    elements: &[Value],
    fx: f64,
    fy: f64,
    image_w: f64,
    image_h: f64,
    fw: f64,
    fh: f64,
) -> Result<(Value, HashMap<String, ElementRecord>), ProtocolError> {
    let mut records = HashMap::new();
    let sx = image_w / fw.max(1.0);
    let sy = image_h / fh.max(1.0);
    let nodes = elements.iter().map(|raw| -> Result<(String, String, Value), ProtocolError> {
        let bounds = raw.get("bounds").unwrap_or(&Value::Null);
        let screen_x = number_at(bounds, "x", 0.0);
        let screen_y = number_at(bounds, "y", 0.0);
        let screen_w = number_at(bounds, "width", number_at(bounds, "w", 1.0)).max(1.0);
        let screen_h = number_at(bounds, "height", number_at(bounds, "h", 1.0)).max(1.0);
        // Windows UIA and HWND geometry are in DPI-aware screen points. Look images
        // are pixels; every element rect below is converted by the window-image scale
        // so coordinate acts can invert through the stored LookRecord without TS state.
        let rect = json!({ "x": (screen_x - fx) * sx, "y": (screen_y - fy) * sy, "w": screen_w * sx, "h": screen_h * sy });
        let native_reference = raw.get("ref").and_then(Value::as_str).unwrap_or("");
        let reference = if native_reference.is_empty() { String::new() } else { format!("win:{look_id}:{native_reference}") };
        let role = raw.get("role").and_then(Value::as_str).unwrap_or("unknown").to_owned();
        let automation_id = raw.get("automationId").and_then(Value::as_str).unwrap_or("").to_owned();
        let runtime_id = parse_runtime_id(raw, "runtimeId", false)?;
        let parent_runtime_id = parse_runtime_id(raw, "parentRuntimeId", true)?;
        let is_secure = raw.get("isPassword").and_then(Value::as_bool).unwrap_or(false);
        let displayed_value = if is_secure { "" } else { raw.get("value").and_then(Value::as_str).unwrap_or("") };
        let text = if displayed_value.is_empty() { raw.get("label").and_then(Value::as_str).unwrap_or("") } else { displayed_value }.to_owned();
        let hwnd = root.get("windowId").and_then(Value::as_i64).unwrap_or(0) as isize;
        let caps = raw.get("capabilities").unwrap_or(&Value::Null);
        let can_press = caps.get("canPress").or_else(|| caps.get("canInvoke")).and_then(Value::as_bool).unwrap_or(false);
        let can_set_value = caps.get("canSetValue").or_else(|| caps.get("canEditText")).and_then(Value::as_bool).unwrap_or(false);
        let can_scroll = caps.get("canScroll").and_then(Value::as_bool).unwrap_or(false);
        if !reference.is_empty() { records.insert(reference.clone(), ElementRecord { hwnd, automation_id: automation_id.clone(), is_secure, runtime_id: runtime_id.clone() }); }
        let node = json!({
            "ref": reference,
            "role": role,
            "subrole": raw.get("className").and_then(Value::as_str).unwrap_or(""),
            "identifier": raw.get("automationId").and_then(Value::as_str).unwrap_or(""),
            "title": raw.get("label").and_then(Value::as_str).unwrap_or(""),
            "description": raw.get("className").and_then(Value::as_str).unwrap_or(""),
            "value": displayed_value,
            "actions": [],
            "canPress": can_press,
            "canFocus": caps.get("isKeyboardFocusable").and_then(Value::as_bool).unwrap_or(false),
            "canSetValue": can_set_value,
            "canScroll": can_scroll,
            "canIncrement": false,
            "canDecrement": false,
            "isTextInput": matches!(raw.get("role").and_then(Value::as_str), Some("edit" | "document")),
            "rect": rect,
            "focused": false,
            "offscreen": caps.get("isOffscreen").and_then(Value::as_bool).unwrap_or(false),
            "pictureOnly": false,
            "truncated": raw.get("truncated").and_then(Value::as_bool).unwrap_or(false),
            "text": if text.is_empty() { json!([]) } else { json!([{ "string": text, "confidence": 1, "rect": rect }]) },
            "children": []
        });
        Ok((runtime_key(&runtime_id), runtime_key(&parent_runtime_id), node))
    }).collect::<Result<Vec<_>, _>>()?;
    let children = nest_outline_nodes(&nodes);
    Ok((
        json!({
            "ref": root_ref,
            "role": root.get("role").and_then(Value::as_str).unwrap_or("Window"),
            "subrole": root.get("subrole").and_then(Value::as_str).unwrap_or(""),
            "identifier": "",
            "title": root.get("title").and_then(Value::as_str).unwrap_or(if kind == "menu" { "Menu" } else { "Window" }),
            "description": "",
            "value": "",
            "actions": [],
            "canPress": false,
            "canFocus": false,
            "canSetValue": false,
            "canScroll": false,
            "canIncrement": false,
            "canDecrement": false,
            "isTextInput": false,
            "rect": { "x": 0, "y": 0, "w": image_w, "h": image_h },
            "focused": root.get("isFocused").and_then(Value::as_bool).unwrap_or(false),
            "offscreen": false,
            "pictureOnly": false,
            "truncated": false,
            "text": [],
            "children": children
        }),
        records,
    ))
}

/// Strict UIA identity: every entry must be an i32 and a RuntimeId must be nonempty.
/// A malformed element stops the look instead of being silently dropped or defaulted.
fn parse_runtime_id(raw: &Value, key: &str, optional: bool) -> Result<Vec<i32>, ProtocolError> {
    let malformed = || ProtocolError::new(format!("Malformed UIA {key}"), ErrorCode::InternalError);
    let Some(value) = raw.get(key).filter(|value| !value.is_null()) else {
        return if optional {
            Ok(Vec::new())
        } else {
            Err(malformed())
        };
    };
    let items = value.as_array().ok_or_else(malformed)?;
    let ids = items
        .iter()
        .map(|item| {
            item.as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .ok_or_else(malformed)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if ids.is_empty() && !optional {
        return Err(malformed());
    }
    Ok(ids)
}

fn runtime_key(runtime_id: &[i32]) -> String {
    runtime_id
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(".")
}

fn nest_outline_nodes(nodes: &[(String, String, Value)]) -> Vec<Value> {
    let index = nodes
        .iter()
        .enumerate()
        .filter(|(_, (key, _, _))| !key.is_empty())
        .map(|(index, (key, _, _))| (key.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut children = vec![Vec::<usize>::new(); nodes.len()];
    let mut roots = Vec::new();
    for (node_index, (_, parent, _)) in nodes.iter().enumerate() {
        match index.get(parent.as_str()).copied() {
            Some(parent_index) if parent_index != node_index => {
                children[parent_index].push(node_index)
            }
            _ => roots.push(node_index),
        }
    }
    fn materialize(
        node_index: usize,
        nodes: &[(String, String, Value)],
        children: &[Vec<usize>],
        path: &mut Vec<usize>,
    ) -> Value {
        let mut node = nodes[node_index].2.clone();
        if path.len() >= 64 || path.contains(&node_index) {
            node["truncated"] = json!(true);
            return node;
        }
        path.push(node_index);
        node["children"] = Value::Array(
            children[node_index]
                .iter()
                .map(|child| materialize(*child, nodes, children, path))
                .collect(),
        );
        path.pop();
        node
    }
    roots
        .into_iter()
        .map(|root| materialize(root, nodes, &children, &mut Vec::new()))
        .collect()
}

fn fresh_look_id() -> Result<String, ProtocolError> {
    Ok(helper_state()
        .lock()
        .map_err(|_| internal("helper state lock poisoned"))?
        .fresh_look_id())
}

fn store_look_record(look_id: String, record: LookRecord) -> Result<(), ProtocolError> {
    let mut state = helper_state()
        .lock()
        .map_err(|_| internal("helper state lock poisoned"))?;
    state.insert_look(look_id, record);
    Ok(())
}

fn look_record_for_element(
    reference: &str,
    base_look_id: Option<&str>,
) -> Option<(LookRecord, ElementRecord)> {
    let state = helper_state().lock().ok()?;
    if let Some(look_id) = base_look_id {
        let look = state.looks.get(look_id)?;
        return look
            .elements
            .get(reference)
            .cloned()
            .map(|element| (look.clone(), element));
    }
    state
        .look_order
        .iter()
        .rev()
        .filter_map(|look_id| state.looks.get(look_id))
        .find_map(|look| {
            look.elements
                .get(reference)
                .cloned()
                .map(|element| (look.clone(), element))
        })
}

fn scoped_outline_root(mut outline: Value, scope_ref: &str) -> Value {
    let mut roots = outline["children"]
        .as_array_mut()
        .map(std::mem::take)
        .unwrap_or_default();
    if roots.is_empty() {
        outline["ref"] = json!(scope_ref);
        outline["truncated"] = json!(false);
        return outline;
    }
    let mut scoped = roots.remove(0);
    scoped["ref"] = json!(scope_ref);
    if !roots.is_empty() {
        if let Some(children) = scoped["children"].as_array_mut() {
            children.extend(roots);
        }
    }
    scoped
}

/// Keep semantic and physical delivery in the same admission transaction.
fn deliver_act<T>(work: impl FnOnce() -> Result<T, ProtocolError>) -> Result<T, ProtocolError> {
    with_physical_input(work)
}

fn handle_act(args: &Value) -> Result<Value, ProtocolError> {
    if INPUT_CLOSED.load(Ordering::Acquire) {
        return Err(cancelled());
    }
    let mut parsed = input::parse_act_request(args)?;
    let record = {
        let state = helper_state()
            .lock()
            .map_err(|_| internal("helper state lock poisoned"))?;
        state.looks.get(&parsed.look_id).cloned().ok_or_else(|| {
            ProtocolError::new(
                format!("Look id '{}' is no longer available", parsed.look_id),
                ErrorCode::StaleLook,
            )
        })?
    };
    if parsed.pid.is_some_and(|pid| pid != record.pid) {
        return Err(invalid("act pid does not own the observed root"));
    }
    parsed.pid = Some(record.pid);
    // A closed or replaced window reports root_stale, not the desktop refusal.
    window::ensure_instance(
        record.hwnd,
        record.instance,
        windows_bridge::desktop::validated_bounds(record.hwnd, Some(record.pid)),
    )?;
    let target_pid = parsed
        .pid
        .or((record.pid != 0).then_some(record.pid))
        .ok_or_else(|| invalid("act requires pid or observed root pid for root deltas"))?;
    let defer_root_delta = args
        .get("deferRootDelta")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let event_cursor = window::root_event_cursor();
    let before = if defer_root_delta {
        None
    } else {
        Some(snapshot_roots(target_pid)?)
    };

    let mut response = deliver_act(|| {
        Ok(match &parsed.target {
            input::ActTarget::Ref(reference) => act_on_ref(args, &parsed, &record, reference)?,
            input::ActTarget::Point { x, y } => {
                input::refuse_keyboard_at_point(&parsed)?;
                if !record.has_image {
                    return Err(ProtocolError::new(
                        "Coordinate targeting is unavailable for this outline-only root",
                        ErrorCode::CoordinateUnavailableForRoot,
                    ));
                }
                with_physical_input(|| {
                    // Rechecked after the lease wait, immediately before delivery.
                    let current = window::ensure_instance(
                        record.hwnd,
                        record.instance,
                        windows_bridge::desktop::validated_bounds(record.hwnd, Some(record.pid)),
                    )?;
                    if (current.x, current.y, current.width, current.height)
                        != (
                            record.frame_x,
                            record.frame_y,
                            record.frame_w,
                            record.frame_h,
                        )
                    {
                        return Err(ProtocolError::new(
                            "Window moved since observation; observe again",
                            ErrorCode::StaleLook,
                        ));
                    }
                    let start =
                        project_vertex(current, (record.image_w, record.image_h), *x, *y, false)?;
                    let (executable, points) = resolved_executable(
                        &parsed,
                        current,
                        (record.image_w, record.image_h),
                        start,
                        false,
                    )?;
                    // Act never restores/raises. Every vertex is admitted before mutation.
                    windows_bridge::guard::deliver_path(
                        current,
                        None,
                        &points,
                        |x, y| {
                            window::ensure_point_owned(record.hwnd, &json!({"x":x,"y":y}))?;
                            Ok(true)
                        },
                        || input::act(&executable),
                    )
                })?
            }
        })
    })?;

    if let Some(before) = before {
        let (after, source, events) = windows_bridge::guard::observe_after_delivery(|| {
            await_delta_snapshot(target_pid, &before, event_cursor)
        })?;
        response = input::response_with_delta(
            response,
            source,
            combined_root_delta(&before, &after, target_pid, events),
        );
    }
    Ok(response)
}

fn handle_act_batch(args: &Value) -> Result<Value, ProtocolError> {
    let actions = args
        .get("actions")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("actBatch requires actions"))?;
    if actions.is_empty() || actions.len() > 20 {
        return Err(invalid("actBatch requires 1...20 actions"));
    }
    let first = input::parse_act_request(&actions[0])?;
    let target_pid = first
        .pid
        .ok_or_else(|| invalid("actBatch actions require pid"))?;
    for action in actions {
        let parsed = input::parse_act_request(action)?;
        if parsed.pid != Some(target_pid) {
            return Err(invalid("actBatch actions must target one pid"));
        }
        if parsed.look_id != first.look_id {
            return Err(invalid("actBatch actions must belong to one look"));
        }
    }
    let before = snapshot_roots(target_pid)?;
    let event_cursor = window::root_event_cursor();
    if !helper_state()
        .lock()
        .map_err(|_| internal("helper state lock poisoned"))?
        .looks
        .contains_key(&first.look_id)
    {
        return Err(ProtocolError::new(
            "Owning look is no longer available",
            ErrorCode::StaleLook,
        ));
    }
    let requires_physical = actions.iter().any(action_may_use_physical_input);
    let execute = || -> Result<(Vec<Value>, Option<usize>), ProtocolError> {
        let mut steps = Vec::new();
        let mut stopped_at = None;
        for (index, action) in actions.iter().enumerate() {
            if INPUT_CLOSED.load(Ordering::Acquire) {
                return Err(cancelled());
            }
            let mut deferred = action.clone();
            deferred["deferRootDelta"] = json!(true);
            let step = match handle_act(&deferred) {
                Ok(step) => step,
                Err(error) => {
                    if error.outcome_uncertain() {
                        return Err(error);
                    }
                    steps.push(json!({ "outcome": "didnt", "error": { "code": error.code.to_string(), "message": error.message } }));
                    stopped_at = Some(index);
                    break;
                }
            };
            let didnt = step.get("outcome").and_then(Value::as_str) == Some("didnt");
            steps.push(step);
            if didnt {
                stopped_at = Some(index);
                break;
            }
        }
        Ok((steps, stopped_at))
    };
    let executed = if requires_physical {
        with_physical_input(execute)
    } else {
        execute()
    };
    let (steps, stopped_at) = executed?;
    let outcome = if steps
        .iter()
        .any(|step| step.get("outcome").and_then(Value::as_str) == Some("didnt"))
    {
        "didnt"
    } else if steps
        .iter()
        .any(|step| step.get("outcome").and_then(Value::as_str) == Some("unknown"))
    {
        "unknown"
    } else {
        "worked"
    };
    let mut response = json!({ "outcome": outcome, "performed": { "transaction": true, "actionCount": steps.len() }, "steps": steps });
    if let Some(index) = stopped_at {
        response["stoppedAt"] = json!(index);
    }
    let (after, source, events) = windows_bridge::guard::observe_after_delivery(|| {
        await_delta_snapshot(target_pid, &before, event_cursor)
    })?;
    response = input::response_with_delta(
        response,
        source,
        combined_root_delta(&before, &after, target_pid, events),
    );
    Ok(response)
}

fn action_may_use_physical_input(action: &Value) -> bool {
    // Advertised patterns can disappear after observation. Reserve the whole
    // foreground batch before any live probe can choose physical fallback.
    input::parse_act_request(action).is_ok_and(|request| request.policy == "foreground")
}

fn act_on_ref(
    args: &Value,
    parsed: &input::ParsedActRequest,
    record: &LookRecord,
    reference: &str,
) -> Result<Value, ProtocolError> {
    let element = record
        .elements
        .get(reference)
        .cloned()
        .ok_or_else(|| ProtocolError::new("Element reference is stale", ErrorCode::StaleRef))?;
    // Even semantic mutation must start from the exact live identity/geometry. Each
    // UIA delivery below resolves its element again and refuses it unless the window
    // is still the observed instance after that resolution.
    live_ref_target(&element, record.instance)?;
    match parsed.action.as_str() {
        "press" | "click" => match windows_bridge::uia::press(
            element.hwnd,
            record.instance,
            &element.runtime_id,
            &element.automation_id,
        )? {
            windows_bridge::uia::PressResult::Invoked => Ok(
                json!({ "outcome": "worked", "performed": { "grounding": "description", "delivery": "ax" } }),
            ),
            windows_bridge::uia::PressResult::Toggled(state) => Ok(
                json!({ "outcome": "worked", "performed": { "grounding": "description", "delivery": "ax" }, "evidence": { "toggleState": state } }),
            ),
            windows_bridge::uia::PressResult::Selected(selected) => Ok(
                json!({ "outcome": if selected { "worked" } else { "didnt" }, "performed": { "grounding": "description", "delivery": "ax" }, "evidence": { "selected": selected } }),
            ),
            windows_bridge::uia::PressResult::Expanded => Ok(
                json!({ "outcome": "worked", "performed": { "grounding": "description", "delivery": "ax" } }),
            ),
            windows_bridge::uia::PressResult::LegacyDefaultAction => Ok(
                json!({ "outcome": "worked", "performed": { "grounding": "description", "delivery": "ax" } }),
            ),
            windows_bridge::uia::PressResult::NoPattern => {
                coordinate_fallback(args, parsed, &element, record.instance)
            }
        },
        "setText" => {
            let text = parsed
                .params
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("");
            match windows_bridge::uia::set_text(
                element.hwnd,
                record.instance,
                &element.runtime_id,
                &element.automation_id,
                text,
            )? {
                windows_bridge::uia::SetTextResult::Set { value } => Ok(
                    windows_bridge::guard::written_text_response(text, value.as_deref()),
                ),
                windows_bridge::uia::SetTextResult::NoPattern => {
                    coordinate_fallback(args, parsed, &element, record.instance)
                }
            }
        }
        "scroll" => {
            let sx = parsed
                .params
                .get("scrollX")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let sy = parsed
                .params
                .get("scrollY")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            match windows_bridge::uia::scroll(
                element.hwnd,
                record.instance,
                &element.runtime_id,
                &element.automation_id,
                sx,
                sy,
            )? {
                windows_bridge::uia::ScrollResult::Scrolled => Ok(
                    json!({ "outcome": "unknown", "performed": { "grounding": "description", "delivery": "ax" } }),
                ),
                windows_bridge::uia::ScrollResult::NoPattern => {
                    coordinate_fallback(args, parsed, &element, record.instance)
                }
            }
        }
        _ => coordinate_fallback(args, parsed, &element, record.instance),
    }
}

fn coordinate_fallback(
    _args: &Value,
    parsed: &input::ParsedActRequest,
    element: &ElementRecord,
    instance: WindowInstance,
) -> Result<Value, ProtocolError> {
    input::policy_allows_raw_input(parsed)?;
    with_physical_input(|| {
        let (window, target) = live_ref_target(element, instance)?;
        let start = (
            (target.bounds.x + target.bounds.width / 2.0).round(),
            (target.bounds.y + target.bounds.height / 2.0).round(),
        );
        let (mut executable, points) =
            resolved_executable(parsed, target.bounds, (1.0, 1.0), start, true)?;
        let validate = || -> Result<(), ProtocolError> {
            let (window, target) = live_ref_target(element, instance)?;
            windows_bridge::guard::validate_path(window, Some(target.bounds), &points, |x, y| {
                window::ensure_point_owned(element.hwnd, &json!({"x":x,"y":y}))?;
                windows_bridge::uia::occlusion_ok(
                    element.hwnd,
                    instance,
                    &element.runtime_id,
                    &element.automation_id,
                    x,
                    y,
                )
            })
        };
        windows_bridge::guard::deliver_path(
            window,
            Some(target.bounds),
            &points,
            |x, y| {
                window::ensure_point_owned(element.hwnd, &json!({"x":x,"y":y}))?;
                windows_bridge::uia::occlusion_ok(
                    element.hwnd,
                    instance,
                    &element.runtime_id,
                    &element.automation_id,
                    x,
                    y,
                )
            },
            || {
                validate()?; // Re-resolve immediately before any mutation.
                if matches!(parsed.action.as_str(), "setText" | "typeText" | "keypress") {
                    windows_bridge::uia::focus_for_input(
                        element.hwnd,
                        instance,
                        &element.runtime_id,
                        &element.automation_id,
                        parsed.action != "keypress",
                    )?;
                    executable["resolvedPoint"] = Value::Null;
                    return windows_bridge::guard::observe_after_delivery(|| {
                        validate()?; // Focus may have changed layout or ownership.
                        input::act(&executable)
                    });
                }
                input::act(&executable)
            },
        )
    })
}

/// Resolve the live target of `element`, refusing unless its window is still `instance`.
fn live_ref_target(
    element: &ElementRecord,
    instance: WindowInstance,
) -> Result<
    (
        windows_bridge::guard::Bounds,
        windows_bridge::guard::LiveTarget,
    ),
    ProtocolError,
> {
    let window = window::ensure_instance(
        element.hwnd,
        instance,
        windows_bridge::desktop::validated_bounds(element.hwnd, Some(instance.pid)),
    )?;
    // The RuntimeId and AutomationId could match an element of a replacement window;
    // `snapshot` refuses one by rechecking the instance after its resolution.
    let snapshot = windows_bridge::uia::snapshot(
        element.hwnd,
        instance,
        &element.runtime_id,
        &element.automation_id,
    )
    .map_err(stale_ref_from_uia)?;
    let target = windows_bridge::guard::LiveTarget {
        runtime_id: snapshot.runtime_id,
        bounds: windows_bridge::guard::Bounds {
            x: snapshot.rect.0,
            y: snapshot.rect.1,
            width: snapshot.rect.2,
            height: snapshot.rect.3,
        },
    };
    windows_bridge::guard::validate_live_target(&element.runtime_id, window, &target)?;
    Ok((window, target))
}

fn project_vertex(
    bounds: windows_bridge::guard::Bounds,
    units: (f64, f64),
    x: f64,
    y: f64,
    normalized: bool,
) -> Result<(f64, f64), ProtocolError> {
    if !bounds.valid()
        || !x.is_finite()
        || !y.is_finite()
        || units.0 <= 0.0
        || units.1 <= 0.0
        || x < 0.0
        || y < 0.0
        || (if normalized {
            x > units.0 || y > units.1
        } else {
            x >= units.0 || y >= units.1
        })
    {
        return Err(invalid("Input vertex is outside its coordinate space"));
    }
    let width = if normalized {
        bounds.width - 1.0
    } else {
        bounds.width
    };
    let height = if normalized {
        bounds.height - 1.0
    } else {
        bounds.height
    };
    let point = (
        (bounds.x + width * x / units.0).round(),
        (bounds.y + height * y / units.1).round(),
    );
    if !bounds.contains(point.0, point.1) {
        return Err(invalid("Rounded input vertex is outside its target"));
    }
    Ok(point)
}

fn resolved_executable(
    parsed: &input::ParsedActRequest,
    bounds: windows_bridge::guard::Bounds,
    units: (f64, f64),
    start: (f64, f64),
    normalized: bool,
) -> Result<(Value, Vec<(f64, f64)>), ProtocolError> {
    let mut executable = input::executable_request(parsed);
    let mut points = vec![start];
    executable["resolvedPoint"] = json!({"x":start.0,"y":start.1});
    if parsed.action == "drag" {
        let path = parsed
            .params
            .get("path")
            .and_then(Value::as_array)
            .filter(|path| !path.is_empty() && path.len() <= 1024)
            .ok_or_else(|| invalid("drag requires 1...1024 path vertices"))?;
        for point in path {
            let x = point
                .get("x")
                .and_then(Value::as_f64)
                .ok_or_else(|| invalid("Invalid drag x"))?;
            let y = point
                .get("y")
                .and_then(Value::as_f64)
                .ok_or_else(|| invalid("Invalid drag y"))?;
            points.push(project_vertex(bounds, units, x, y, normalized)?);
        }
        executable["resolvedPath"] =
            Value::Array(points.iter().map(|&(x, y)| json!({"x":x,"y":y})).collect());
    }
    Ok((executable, points))
}

fn stale_ref_from_uia(message: String) -> ProtocolError {
    if message == window::STALE_INSTANCE {
        window::unverified_instance(true)
    } else if message.contains("stale") || message.contains("Element reference") {
        ProtocolError::new("Element reference is stale", ErrorCode::StaleRef)
    } else {
        ProtocolError::new(message, ErrorCode::InternalError)
    }
}

fn snapshot_roots(pid: u64) -> Result<RootSnapshot, ProtocolError> {
    let mut store = RefStore::new();
    let value = window::list_windows(&mut store, Some(pid))?;
    Ok(RootSnapshot {
        roots: roots_array(&value)
            .into_iter()
            .map(|root| (root_identity(&root), root))
            .collect(),
        foreground_pid: window::foreground_pid(),
    })
}

fn root_signature(snapshot: &RootSnapshot) -> (Vec<String>, Option<u64>) {
    let mut keys = snapshot.roots.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    (keys, snapshot.foreground_pid)
}

fn await_delta_snapshot(
    pid: u64,
    before: &RootSnapshot,
    event_cursor: u64,
) -> Result<(RootSnapshot, &'static str, Vec<Value>), ProtocolError> {
    let before_sig = root_signature(before);
    let deadline = Instant::now() + Duration::from_millis(300);
    let mut signaled = false;
    let mut after = snapshot_roots(pid)?;
    while Instant::now() < deadline {
        after = snapshot_roots(pid)?;
        if root_signature(&after) != before_sig
            || !window::root_events_since(event_cursor, pid).is_empty()
        {
            signaled = true;
            break;
        }
        sleep(Duration::from_millis(30));
    }
    if signaled {
        // Signals accelerate the settle window, but the reported delta is always
        // a full before/after snapshot diff.  Keep re-diffing briefly so a
        // close-then-open transition (menus/popups) does not report only the
        // first observed close.
        for _ in 0..3 {
            sleep(Duration::from_millis(60));
            after = snapshot_roots(pid)?;
        }
        let events = window::root_events_since(event_cursor, pid);
        let source = if events.is_empty() {
            "win-poll"
        } else {
            "win-event+snapshot"
        };
        Ok((after, source, events))
    } else {
        Ok((after, "snapshot", Vec::new()))
    }
}

fn combined_root_delta(
    before: &RootSnapshot,
    after: &RootSnapshot,
    target_pid: u64,
    events: Vec<Value>,
) -> Vec<Value> {
    let mut delta = root_delta(before, after, target_pid);
    for event in events {
        let duplicate = delta.iter().any(|item| {
            item.get("change") == event.get("change")
                && item.get("kind") == event.get("kind")
                && item.get("title") == event.get("title")
                && item.get("pid") == event.get("pid")
        });
        if !duplicate {
            delta.push(event);
        }
    }
    delta
}

fn root_delta(before: &RootSnapshot, after: &RootSnapshot, target_pid: u64) -> Vec<Value> {
    let mut delta = Vec::new();
    for (key, root) in &after.roots {
        if !before.roots.contains_key(key) {
            delta.push(delta_item("appeared", root));
        }
    }
    for (key, root) in &before.roots {
        if !after.roots.contains_key(key) {
            delta.push(delta_item("closed", root));
        }
    }
    for (key, root) in &after.roots {
        if root.get("isFocused").and_then(Value::as_bool) == Some(true)
            && before
                .roots
                .get(key)
                .and_then(|r| r.get("isFocused"))
                .and_then(Value::as_bool)
                != Some(true)
        {
            delta.push(delta_item("focused", root));
        }
    }
    if before.foreground_pid != after.foreground_pid && after.foreground_pid != Some(target_pid) {
        delta.push(json!({ "change": "focused", "kind": "app", "title": "Foreground app", "pid": after.foreground_pid.unwrap_or(0) }));
    }
    delta
}

fn delta_item(change: &str, root: &Value) -> Value {
    let mut item = json!({
        "change": change,
        "kind": root.get("kind").and_then(Value::as_str).unwrap_or("window"),
        "ref": root.get("rootRef").and_then(Value::as_str).unwrap_or(""),
        "title": root.get("title").and_then(Value::as_str).unwrap_or(""),
        "pid": root.get("pid").and_then(Value::as_u64).unwrap_or(0)
    });
    if let Some(is_modal) = root.get("isModal").and_then(Value::as_bool) {
        item["isModal"] = json!(is_modal);
    }
    if let Some(metadata) = root.get("metadata") {
        item["metadata"] = metadata.clone();
    }
    item
}

/// The exact native root admitted by the caller, never inferred from live discovery.
#[derive(Clone, Copy)]
struct AdmittedRoot {
    hwnd: isize,
    pid: u64,
}

impl AdmittedRoot {
    fn parse(args: &Value) -> Result<Self, ProtocolError> {
        let pid = args
            .get("pid")
            .and_then(Value::as_u64)
            .filter(|&pid| pid > 0 && u32::try_from(pid).is_ok())
            .ok_or_else(|| invalid("Expected a valid target pid"))?;
        let hwnd = args
            .get("windowId")
            .and_then(Value::as_i64)
            .and_then(|id| isize::try_from(id).ok())
            .filter(|&id| id != 0)
            .ok_or_else(|| invalid("Expected an exact target windowId"))?;
        Ok(Self { hwnd, pid })
    }

    /// Return `look_id` only if this admitted root issued it.
    fn owned_look<'a>(
        self,
        state: &'a HelperState,
        look_id: &str,
    ) -> Result<&'a LookRecord, ProtocolError> {
        let look = state.looks.get(look_id).ok_or_else(|| {
            ProtocolError::new("Owning look is no longer available", ErrorCode::StaleLook)
        })?;
        if self.pid != look.pid || self.hwnd != look.hwnd {
            return Err(ProtocolError::new(
                "Owning look does not match the admitted root",
                ErrorCode::StaleLook,
            ));
        }
        Ok(look)
    }

    /// Return the window instance this root was admitted as: the owning look's when
    /// `look_id` is given, else the one `root_ref` was issued for at discovery. The
    /// ref is required without a look; a later rediscovery binds a replacement to a
    /// new ref, never to this one.
    fn admitted_instance(
        self,
        state: &HelperState,
        look_id: Option<&str>,
        root_ref: Option<&str>,
    ) -> Result<WindowInstance, ProtocolError> {
        if let Some(look_id) = look_id {
            return Ok(self.owned_look(state, look_id)?.instance);
        }
        let root_ref = root_ref.ok_or_else(|| invalid("Expected the exact target rootRef"))?;
        match state.root_instances.get(root_ref) {
            Some((hwnd, Some(instance))) if *hwnd == self.hwnd && instance.pid == self.pid => {
                Ok(*instance)
            }
            Some((hwnd, None)) if *hwnd == self.hwnd => Err(window::unverified_instance(false)),
            _ => Err(window::unverified_instance(true)),
        }
    }
}

fn read_text_element(
    args: &Value,
    state: &HelperState,
) -> Result<(ElementRecord, WindowInstance), ProtocolError> {
    let look_id = args
        .get("lookId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("uiaReadText requires lookId"))?;
    let element_ref = args
        .get("elementRef")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("uiaReadText requires elementRef"))?;
    let root = AdmittedRoot::parse(args)?;
    // Resolve from the validated record so the owner check and lookup cannot diverge.
    let look = root.owned_look(state, look_id)?;
    Ok((look.element(element_ref)?, look.instance))
}

fn handle_read_text(args: &Value) -> Result<Value, ProtocolError> {
    handle_read_text_with(
        args,
        helper_state(),
        window::window_instance,
        |hwnd, pid| windows_bridge::desktop::validated_bounds(hwnd, Some(pid)).map(drop),
        windows_bridge::uia::acquire_root,
        |root, element| {
            windows_bridge::uia::read_text_in_root(
                root,
                &element.runtime_id,
                &element.automation_id,
            )
        },
    )
}

/// Read text through the owner-bound walk, with Win32 and UIA access injected.
fn handle_read_text_with<Root>(
    args: &Value,
    state: &Mutex<HelperState>,
    mut owner: impl FnMut(isize) -> Option<WindowInstance>,
    desktop_preflight: impl FnOnce(isize, u64) -> Result<(), ProtocolError>,
    acquire_root: impl FnOnce(isize) -> Result<Root, String>,
    read_in_root: impl FnOnce(Root, &ElementRecord) -> Result<String, String>,
) -> Result<Value, ProtocolError> {
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(4096) as usize;
    let (element, instance) = {
        let state = state
            .lock()
            .map_err(|_| internal("helper state lock poisoned"))?;
        read_text_element(args, &state)?
    };
    if element.is_secure {
        return Err(ProtocolError::new(
            "Refers to a secure text field; refusing to read its value",
            ErrorCode::SecureTextUnreadable,
        ));
    }
    // The preflight also refuses a closed or reassigned HWND; report that as owner
    // loss, keeping `coordinate_blocked` for a refusal while the owner still matches.
    if let Err(refused) = desktop_preflight(element.hwnd, instance.pid) {
        return Err(if owner(element.hwnd) == Some(instance) {
            refused
        } else {
            owned_walk_error(
                windows_bridge::uia::OwnedWalkError::RootStale,
                "Read",
                stale_ref_from_uia,
            )
        });
    }
    let text = windows_bridge::uia::walk_owned_root(
        element.hwnd,
        instance,
        &mut owner,
        acquire_root,
        |root| read_in_root(root, &element),
    )
    .map_err(|error| owned_walk_error(error, "Read", stale_ref_from_uia))?;
    let characters = text.chars().collect::<Vec<_>>();
    let end = offset.saturating_add(limit).min(characters.len());
    let slice = if offset >= characters.len() {
        String::new()
    } else {
        characters[offset..end].iter().collect()
    };
    Ok(
        json!({ "text": slice, "offset": offset, "limit": limit, "totalChars": characters.len(), "hasMore": end < characters.len() }),
    )
}

fn handle_wait_for(args: &Value) -> Result<Value, ProtocolError> {
    let timeout_ms = args
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(10_000)
        .clamp(100, 60_000);
    let mut deadline = None;
    handle_wait_for_with(
        args,
        helper_state(),
        || {
            if deadline.is_some() {
                sleep(Duration::from_millis(150));
            }
            Instant::now()
                < *deadline
                    .get_or_insert_with(|| Instant::now() + Duration::from_millis(timeout_ms))
        },
        window::window_instance,
        windows_bridge::uia::acquire_root,
        windows_bridge::uia::root_elements,
    )
}

/// Map an owner-bound UIA walk failure; UIA errors use the caller's mapping.
fn owned_walk_error(
    error: windows_bridge::uia::OwnedWalkError,
    operation: &str,
    uia_error: impl FnOnce(String) -> ProtocolError,
) -> ProtocolError {
    match error {
        windows_bridge::uia::OwnedWalkError::RootStale => ProtocolError::new(
            format!("{operation} target is no longer the admitted window instance; rediscover it with find_roots"),
            ErrorCode::RootStale,
        ),
        windows_bridge::uia::OwnedWalkError::Uia(message) => uia_error(message),
    }
}

fn handle_wait_for_with<Root>(
    args: &Value,
    state: &Mutex<HelperState>,
    mut next_poll: impl FnMut() -> bool,
    mut owner: impl FnMut(isize) -> Option<WindowInstance>,
    mut acquire_root: impl FnMut(isize) -> Result<Root, String>,
    mut root_elements: impl FnMut(Root) -> Result<Vec<Value>, String>,
) -> Result<Value, ProtocolError> {
    let root = AdmittedRoot::parse(args)?;
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .map(|s| s.to_lowercase());
    let role = args.get("role").and_then(Value::as_str).map(str::to_owned);
    let expected_value = args
        .get("value")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_lowercase());
    let gone = args.get("gone").and_then(Value::as_bool).unwrap_or(false);
    let scope_exact = args
        .get("scopeExact")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let look_id = args.get("lookId").and_then(Value::as_str);
    let scope_ref = args.get("scopeRef").and_then(Value::as_str);
    if look_id.is_none() && scope_ref.is_some() {
        return Err(invalid("scopeRef requires lookId"));
    }
    if text.is_none() && role.is_none() && expected_value.is_none() {
        return Err(invalid("uiaWaitFor requires text, role, or value"));
    }
    let (instance, scope_runtime_id) = {
        let state = state
            .lock()
            .map_err(|_| internal("helper state lock poisoned"))?;
        let root_ref = args
            .get("rootRef")
            .or_else(|| args.get("windowRef"))
            .and_then(Value::as_str);
        let instance = root.admitted_instance(&state, look_id, root_ref)?;
        // A valid scope from another root must never steer this root's UIA poll.
        let scope_runtime_id = match (look_id, scope_ref) {
            (Some(look_id), Some(scope_ref)) => Some(
                root.owned_look(&state, look_id)?
                    .element(scope_ref)?
                    .runtime_id,
            ),
            _ => None,
        };
        (instance, scope_runtime_id)
    };
    let mut node_count = 0;
    while next_poll() {
        let elements = windows_bridge::uia::walk_owned_root(
            root.hwnd,
            instance,
            &mut owner,
            &mut acquire_root,
            &mut root_elements,
        )
        .map_err(|error| owned_walk_error(error, "Wait", internal))?;
        node_count = elements.len();
        let parents: HashMap<String, String> = elements
            .iter()
            .filter_map(|element| {
                let runtime = element.get("runtimeId")?.as_array()?;
                let parent = element.get("parentRuntimeId")?.as_array()?;
                Some((
                    serde_json::to_string(runtime).ok()?,
                    serde_json::to_string(parent).ok()?,
                ))
            })
            .collect();
        let scope_key = scope_runtime_id
            .as_ref()
            .and_then(|id| serde_json::to_string(id).ok());
        let found = elements.iter().any(|element| {
            if let Some(scope_key) = &scope_key {
                let Some(mut current) = element
                    .get("runtimeId")
                    .and_then(Value::as_array)
                    .and_then(|id| serde_json::to_string(id).ok())
                else {
                    return false;
                };
                let mut within_scope = false;
                for _ in 0..64 {
                    if &current == scope_key {
                        within_scope = true;
                        break;
                    }
                    if scope_exact {
                        break;
                    }
                    let Some(parent) = parents.get(&current) else {
                        break;
                    };
                    if parent == &current {
                        break;
                    }
                    current = parent.clone();
                }
                if !within_scope {
                    return false;
                }
            }
            let candidate_text = ["value", "label", "name", "title"]
                .iter()
                .filter_map(|key| element.get(*key).and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            let candidate_role = element.get("role").and_then(Value::as_str).unwrap_or("");
            let candidate_value = element
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_lowercase();
            text.as_ref()
                .map(|needle| candidate_text.contains(needle))
                .unwrap_or(true)
                && role.as_ref().map(|r| candidate_role == r).unwrap_or(true)
                && expected_value
                    .as_ref()
                    .map(|value| candidate_value == *value)
                    .unwrap_or(true)
        });
        if found != gone {
            return Ok(
                json!({ "found": true, "gone": if gone { Some(true) } else { None::<bool> }, "nodeCount": node_count }),
            );
        }
    }
    Ok(json!({ "found": false, "timedOut": true, "nodeCount": node_count }))
}

fn handle_open_browser_location(args: &Value) -> Result<Value, ProtocolError> {
    let app_name = args
        .get("appName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    if app_name.trim().is_empty() {
        return Err(invalid(
            "openBrowserLocation requires an explicit browser appName",
        ));
    }
    let roots = handle_list_roots(&json!({}))?;
    let root = roots_array(&roots).into_iter().find(|root| {
        root.get("isBrowser").and_then(Value::as_bool) == Some(true)
            && root
                .get("appName")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase()
                .contains(&app_name)
    });
    if let Some(root) = root {
        let hwnd = root.get("windowId").and_then(Value::as_i64).unwrap_or(0) as isize;
        let url = args
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("openBrowserLocation requires url"))?;
        with_physical_input(|| {
            #[cfg(windows)]
            windows_bridge::desktop::validated_bounds(
                hwnd,
                root.get("pid").and_then(Value::as_u64),
            )?;
            window::request_foreground(hwnd)?;
            input::open_browser_location(url)
        })?;
        Ok(json!({ "opened": true }))
    } else {
        Err(ProtocolError::new("Target browser window was not found; refusing to type into the currently focused window", ErrorCode::TargetNotFound))
    }
}

fn roots_array(value: &Value) -> Vec<Value> {
    value
        .get("roots")
        .or_else(|| value.get("windows"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn root_identity(root: &Value) -> String {
    if let Some(id) = root.get("windowId").and_then(Value::as_i64) {
        return format!("window:{id}");
    }
    format!(
        "meta:{}:{}:{}",
        root.get("kind").and_then(Value::as_str).unwrap_or("window"),
        root.get("title").and_then(Value::as_str).unwrap_or(""),
        root.get("rootRef").and_then(Value::as_str).unwrap_or("")
    )
}

fn number_at(value: &Value, key: &str, fallback: f64) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(fallback)
}
fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(message.into(), ErrorCode::InvalidRequest)
}
fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(message.into(), ErrorCode::InternalError)
}
fn now_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// A broken response pipe is terminal, never evidence of successful delivery.
fn emit_response(response: &Response) {
    let Ok(json) = serde_json::to_string(response) else {
        let _ = writeln!(
            io::stderr().lock(),
            "Response serialization failed; stopping helper"
        );
        terminate_without_ack(Instant::now() + SHUTDOWN_GRACE);
    };
    if writeln!(io::stdout().lock(), "{json}").is_err() {
        let _ = writeln!(
            io::stderr().lock(),
            "Output stream failed; stopping helper without replay"
        );
        terminate_without_ack(Instant::now() + SHUTDOWN_GRACE);
    }
}

/// Preserve uncertainty when a disconnected owner leaves admitted work behind.
fn cancelled() -> ProtocolError {
    ProtocolError::uncertain(
        "Input stream closed; stopping without replay",
        ErrorCode::CaptureFailed,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests changing terminal admission must not race tests entering delivery.
    static ADMISSION_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn semantic_delivery_holds_the_same_lease_as_checked_keyboard_input() {
        let _admission = ADMISSION_TEST_LOCK.lock().unwrap();
        let result = deliver_act(|| {
            assert!(IN_PHYSICAL_TRANSACTION.with(Cell::get));
            assert!(physical_input_lock().try_lock().is_err());
            Ok(17)
        });
        assert_eq!(result.unwrap(), 17);
    }

    #[test]
    fn malformed_runtime_ids_stop_the_look() {
        let ok = json!({"runtimeId":[42,1]});
        assert_eq!(
            parse_runtime_id(&ok, "runtimeId", false).unwrap(),
            vec![42, 1]
        );
        assert!(parse_runtime_id(&ok, "parentRuntimeId", true)
            .unwrap()
            .is_empty());
        for bad in [
            json!({}),
            json!({"runtimeId":[]}),
            json!({"runtimeId":[1,"x"]}),
            json!({"runtimeId":[1.5]}),
            json!({"runtimeId":[4294967296i64]}),
            json!({"runtimeId":"1"}),
        ] {
            assert!(parse_runtime_id(&bad, "runtimeId", false).is_err(), "{bad}");
        }
        assert!(parse_runtime_id(
            &json!({"parentRuntimeId":[1,null]}),
            "parentRuntimeId",
            true
        )
        .is_err());
    }

    #[test]
    fn keyboard_actions_at_a_point_are_refused() {
        for action in ["typeText", "keypress", "setText"] {
            let parsed = input::parse_act_request(&json!({"lookId":"l","action":action,"policy":"foreground","target":{"x":1,"y":2},"params":{"text":"t","keys":["a"]}})).unwrap();
            let error = input::refuse_keyboard_at_point(&parsed).unwrap_err();
            assert_eq!(error.code, ErrorCode::CoordinateBlocked);
            assert!(!error.outcome_uncertain());
        }
        let click = input::parse_act_request(&json!({"lookId":"l","action":"click","policy":"foreground","target":{"x":1,"y":2},"params":{}})).unwrap();
        assert!(input::refuse_keyboard_at_point(&click).is_ok());
        let by_ref = input::parse_act_request(&json!({"lookId":"l","action":"typeText","policy":"foreground","target":{"ref":"r"},"params":{"text":"t"}})).unwrap();
        assert!(input::refuse_keyboard_at_point(&by_ref).is_ok());
    }

    #[test]
    fn malformed_params_refuse_before_any_field_can_be_cleared_or_clicked() {
        for (action, params) in [
            ("setText", json!({})),
            ("typeText", json!({"text":null})),
            ("click", json!({"button":"unexpected"})),
            ("keypress", json!({"keys":["ctrl",42]})),
        ] {
            assert!(input::parse_act_request(&json!({"lookId":"look","action":action,"policy":"foreground","target":{"ref":"ref"},"params":params})).is_err());
        }
        assert!(input::parse_act_request(&json!({"lookId":"look","action":"setText","target":{"ref":"ref"},"params":{"text":""}})).is_ok(),"explicit empty value remains supported");
    }

    #[test]
    fn attacker_resolution_is_discarded_and_ref_drag_is_built_from_live_bounds() {
        let args = json!({"lookId":"look","action":"drag","policy":"foreground","target":{"ref":"ref"},
            "resolvedPoint":{"x":99999,"y":99999},"resolvedPath":[{"x":99999,"y":99999}],"resolvedUnknown":true,
            "params":{"path":[{"x":0.0,"y":1.0},{"x":1.0,"y":0.0}],"resolvedNested":{"resolvedOther":true}}});
        let parsed = input::parse_act_request(&args).unwrap();
        let bounds = windows_bridge::guard::Bounds {
            x: -100.0,
            y: 20.0,
            width: 50.0,
            height: 40.0,
        };
        let (executable, points) =
            resolved_executable(&parsed, bounds, (1.0, 1.0), (-75.0, 40.0), true).unwrap();
        assert_eq!(points, vec![(-75.0, 40.0), (-100.0, 59.0), (-51.0, 20.0)]);
        assert!(executable.get("resolvedUnknown").is_none());
        assert!(executable["params"].get("resolvedNested").is_none());
        assert_eq!(executable["resolvedPath"][0], json!({"x":-75.0,"y":40.0}));
        assert!(project_vertex(bounds, (100.0, 100.0), 101.0, 0.0, false).is_err());
        assert!(project_vertex(bounds, (100.0, 100.0), f64::NAN, 0.0, false).is_err());
    }

    #[test]
    fn terminal_cleanup_waits_for_current_owner_and_bounds_stuck_input() {
        let lock = Mutex::new(());
        let active = lock.lock().unwrap();
        assert!(!wait_for_input_cleanup(&lock, Instant::now()));
        drop(active);
        assert!(wait_for_input_cleanup(
            &lock,
            Instant::now() + SHUTDOWN_GRACE
        ));
    }

    #[test]
    fn terminal_admission_cannot_start_another_physical_operation() {
        let _admission = ADMISSION_TEST_LOCK.lock().unwrap();
        INPUT_CLOSED.store(true, Ordering::Release);
        let ran = Cell::new(false);
        let result = with_physical_input(|| {
            ran.set(true);
            Ok(())
        });
        INPUT_CLOSED.store(false, Ordering::Release);
        assert!(!ran.get());
        assert!(result.unwrap_err().outcome_uncertain());
    }

    fn root(id: i64, pid: u64, title: &str, focused: bool) -> Value {
        json!({ "windowId": id, "kind": "window", "title": title, "pid": pid, "rootRef": format!("@w{id}"), "isFocused": focused })
    }

    fn snap(roots: Vec<Value>, foreground_pid: Option<u64>) -> RootSnapshot {
        RootSnapshot {
            roots: roots
                .into_iter()
                .map(|root| (root_identity(&root), root))
                .collect(),
            foreground_pid,
        }
    }

    #[test]
    fn root_delta_uses_act_time_baseline_for_two_acts_one_look() {
        let look_time = snap(vec![root(1, 1, "A", true)], Some(1));
        let after_first = snap(vec![root(1, 1, "A", false), root(2, 1, "B", true)], Some(1));
        let after_second = snap(
            vec![
                root(1, 1, "A", false),
                root(2, 1, "B", false),
                root(3, 1, "C", true),
            ],
            Some(1),
        );
        let first = root_delta(&look_time, &after_first, 1);
        assert!(first
            .iter()
            .any(|item| item["title"] == "B" && item["change"] == "appeared"));
        let second = root_delta(&after_first, &after_second, 1);
        assert!(
            !second
                .iter()
                .any(|item| item["title"] == "B" && item["change"] == "appeared"),
            "second act must not re-report first act delta"
        );
        assert!(second
            .iter()
            .any(|item| item["title"] == "C" && item["change"] == "appeared"));
    }

    #[test]
    fn root_delta_scopes_to_target_pid_and_foreground_flip() {
        let before = snap(vec![root(1, 1, "Target", true)], Some(1));
        let after_same_pid = snap(
            vec![root(1, 1, "Target", false), root(2, 1, "Dialog", true)],
            Some(1),
        );
        assert!(root_delta(&before, &after_same_pid, 1)
            .iter()
            .any(|item| item["title"] == "Dialog" && item["change"] == "appeared"));

        let after_other_pid_filtered = snap(vec![root(1, 1, "Target", true)], Some(1));
        assert!(
            root_delta(&before, &after_other_pid_filtered, 1).is_empty(),
            "other-pid window churn is excluded before diffing"
        );

        let foreground_flip = snap(vec![root(1, 1, "Target", true)], Some(2));
        let delta = root_delta(&before, &foreground_flip, 1);
        assert!(delta
            .iter()
            .any(|item| item["change"] == "focused" && item["kind"] == "app" && item["pid"] == 2));
    }

    #[test]
    fn root_delta_coalesces_close_then_open_from_final_snapshot() {
        let before = snap(
            vec![root(1, 1, "Editor", false), root(2, 1, "Old menu", true)],
            Some(1),
        );
        let after = snap(
            vec![root(1, 1, "Editor", false), root(3, 1, "File menu", true)],
            Some(1),
        );
        let delta = root_delta(&before, &after, 1);
        assert!(delta
            .iter()
            .any(|item| item["title"] == "Old menu" && item["change"] == "closed"));
        assert!(delta
            .iter()
            .any(|item| item["title"] == "File menu" && item["change"] == "appeared"));
    }

    #[test]
    fn diagnostics_bind_guarded_helper_capability_to_protocol_5() {
        let value = diagnostics();
        assert_eq!(value["protocolVersion"], 5);
        assert_eq!(value["architectureVersion"], 1);
        assert_eq!(value["capabilities"], json!(["fail-closed-live-target-v1"]));
    }

    #[test]
    fn browser_location_refuses_an_unspecified_app_before_discovery_or_input() {
        let error =
            handle_open_browser_location(&json!({"url":"https://example.invalid/"})).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidRequest);
        assert!(!error.outcome_uncertain());
    }

    #[test]
    fn action_batch_rejects_empty_transactions() {
        let error = handle_act_batch(&json!({ "actions": [] })).expect_err("empty batch must fail");
        assert_eq!(error.code, ErrorCode::InvalidRequest);
    }

    /// The window instance a scripted owner reports for `pid`, before any replacement.
    fn owned_by(pid: u64) -> WindowInstance {
        WindowInstance {
            pid,
            process_started: 100 + pid,
            token: 1000 + pid as usize,
        }
    }

    /// Scripted owner answers for owners that only differ by PID or presence.
    fn owned_by_all(pids: &[Option<u64>]) -> Vec<Option<WindowInstance>> {
        pids.iter().map(|pid| pid.map(owned_by)).collect()
    }

    /// Same HWND and PID as `owned_by(pid)`: a new window in the same process, then a
    /// new process that reused the PID.
    fn replacements_of(pid: u64) -> [WindowInstance; 2] {
        let original = owned_by(pid);
        [
            WindowInstance {
                token: original.token + 1,
                ..original
            },
            WindowInstance {
                process_started: original.process_started + 1,
                ..original
            },
        ]
    }

    fn look_with_element(x: f64) -> LookRecord {
        LookRecord {
            pid: 1,
            hwnd: 1,
            instance: owned_by(1),
            frame_x: 0.0,
            frame_y: 0.0,
            frame_w: 100.0,
            frame_h: 100.0,
            image_w: 100.0,
            image_h: 100.0,
            has_image: false,
            elements: HashMap::from([(
                "same-ref".to_owned(),
                ElementRecord {
                    hwnd: 1,
                    automation_id: String::new(),
                    is_secure: false,
                    runtime_id: vec![x as i32],
                },
            )]),
        }
    }

    #[test]
    fn read_text_checks_the_owning_looks_window_before_uia() {
        let look_id = "read-text-owner-check";
        let mut look = look_with_element(1.0);
        look.elements.get_mut("same-ref").unwrap().hwnd = 0;
        helper_state()
            .lock()
            .unwrap()
            .insert_look(look_id.to_owned(), look);
        let error = handle_read_text(
            &json!({"lookId": look_id, "elementRef": "same-ref", "pid": 1, "windowId": 1}),
        )
        .unwrap_err();
        // No live window owns HWND 0 on any platform, so the refusal is owner loss.
        assert_eq!(error.code, ErrorCode::RootStale);
    }

    /// Run one owner-bound text read with scripted owner answers and fake UIA access.
    fn scripted_read(
        owners: &[Option<u64>],
        preflight: Result<(), ProtocolError>,
        read: impl FnOnce() -> Result<String, String>,
    ) -> (Result<Value, ProtocolError>, usize) {
        scripted_instance_read(&owned_by_all(owners), preflight, read)
    }

    /// Run one owner-bound text read with scripted window instances.
    fn scripted_instance_read(
        owners: &[Option<WindowInstance>],
        preflight: Result<(), ProtocolError>,
        read: impl FnOnce() -> Result<String, String>,
    ) -> (Result<Value, ProtocolError>, usize) {
        let mut state = HelperState::new(1);
        let mut look = look_with_element(1.0);
        look.pid = 7;
        look.hwnd = 22;
        look.instance = owned_by(7);
        look.elements.get_mut("same-ref").unwrap().hwnd = 22;
        state.insert_look("look".to_owned(), look);
        let mut owners = owners.iter().copied();
        let mut reads = 0;
        let result = handle_read_text_with(
            &json!({"lookId": "look", "elementRef": "same-ref", "pid": 7, "windowId": 22, "offset": 1, "limit": 3}),
            &Mutex::new(state),
            |hwnd| {
                assert_eq!(hwnd, 22);
                owners.next().expect("unexpected additional owner check")
            },
            |hwnd, pid| {
                assert_eq!((hwnd, pid), (22, 7));
                preflight
            },
            |hwnd| {
                assert_eq!(hwnd, 22);
                Ok(())
            },
            |(), element| {
                assert_eq!(element.runtime_id, vec![1]);
                reads += 1;
                read()
            },
        );
        (result, reads)
    }

    fn desktop_refusal() -> Result<(), ProtocolError> {
        Err(ProtocolError::new(
            "Target is not on the interactive desktop",
            ErrorCode::CoordinateBlocked,
        ))
    }

    #[test]
    fn read_reports_owner_loss_behind_a_desktop_refusal_as_root_stale() {
        // The preflight refuses a closed or reassigned HWND before any UIA access.
        for owner in [None, Some(8)] {
            let (result, reads) = scripted_read(&[owner], desktop_refusal(), || {
                panic!("must not read a lost root")
            });
            assert_eq!(result.unwrap_err().code, ErrorCode::RootStale);
            assert_eq!(reads, 0);
        }
    }

    #[test]
    fn read_keeps_a_desktop_refusal_while_the_owner_holds() {
        let (result, reads) = scripted_read(&[Some(7)], desktop_refusal(), || {
            panic!("must not read a refused desktop")
        });
        assert_eq!(result.unwrap_err().code, ErrorCode::CoordinateBlocked);
        assert_eq!(reads, 0);
    }

    #[test]
    fn read_refuses_a_replacement_root_before_reading_it() {
        // Owned at the pre-check, replaced by the time ElementFromHandle returned.
        let (result, reads) = scripted_read(&[Some(7), Some(8)], Ok(()), || {
            panic!("must not read a replacement root")
        });
        assert_eq!(result.unwrap_err().code, ErrorCode::RootStale);
        assert_eq!(reads, 0);
    }

    #[test]
    fn read_discards_text_when_ownership_changed_during_it() {
        for after in [Some(8), None] {
            let (result, reads) = scripted_read(&[Some(7), Some(7), after], Ok(()), || {
                Ok("replacement secret".to_owned())
            });
            let error = result.unwrap_err();
            assert_eq!(error.code, ErrorCode::RootStale);
            assert!(!error.message.contains("secret"));
            assert_eq!(reads, 1);
        }
    }

    #[test]
    fn read_returns_text_while_the_owner_holds() {
        let (result, reads) = scripted_read(&[Some(7), Some(7), Some(7)], Ok(()), || {
            Ok("Ready".to_owned())
        });
        let result = result.unwrap();
        assert_eq!(result["text"], "ead");
        assert_eq!(result["totalChars"], 5);
        assert_eq!(result["hasMore"], true);
        assert_eq!(reads, 1);
    }

    #[test]
    fn read_refuses_a_same_hwnd_same_pid_replacement_window() {
        // One fake read shared by every case, so a refused case adds no unrun function.
        let secret = || Ok("replacement secret".to_owned());
        for replacement in replacements_of(7) {
            // Replaced before the walk, after acquiring its root, and during the read.
            for owners in [
                vec![Some(replacement)],
                vec![Some(owned_by(7)), Some(replacement)],
                vec![Some(owned_by(7)), Some(owned_by(7)), Some(replacement)],
            ] {
                let reads_before_check = usize::from(owners.len() == 3);
                let (result, reads) = scripted_instance_read(&owners, Ok(()), secret);
                let error = result.unwrap_err();
                assert_eq!(error.code, ErrorCode::RootStale);
                assert!(!error.message.contains("secret"));
                assert_eq!(reads, reads_before_check);
            }
            // Behind a desktop refusal, the replacement is owner loss, not that refusal.
            let (result, reads) =
                scripted_instance_read(&[Some(replacement)], desktop_refusal(), secret);
            assert_eq!(result.unwrap_err().code, ErrorCode::RootStale);
            assert_eq!(reads, 0);
        }
    }

    #[test]
    fn helper_refuses_protocol_4_clients_without_owner_bound_reads() {
        assert_eq!(PROTOCOL_VERSION, 5);
        let response = handle_request(&Request {
            protocol_version: 4,
            id: "old".to_owned(),
            cmd: "uiaReadText".to_owned(),
            args: json!({"lookId": "look_1", "elementRef": "same-ref"}),
        });
        assert!(!response.ok);
        let error = response.error.unwrap();
        assert_eq!(error.code, ErrorCode::InvalidRequest);
        assert!(error.message.contains("protocol 4; expected 5"));
    }

    /// Deterministic stand-in for `RandomState`, keyed by an explicit seed.
    struct SeededEntropy(u64);

    impl BuildHasher for SeededEntropy {
        type Hasher = std::collections::hash_map::DefaultHasher;

        fn build_hasher(&self) -> Self::Hasher {
            let mut hasher = Self::Hasher::new();
            std::hash::Hasher::write_u64(&mut hasher, self.0);
            hasher
        }
    }

    #[test]
    fn look_generations_follow_the_injected_entropy() {
        let generation = |seed| HelperState::from_entropy(&SeededEntropy(seed)).look_generation;
        assert_eq!(generation(1), generation(1), "the same seed reproduces");
        assert_ne!(generation(1), generation(2), "different seeds differ");
        let mut first = HelperState::from_entropy(&SeededEntropy(1));
        let mut second = HelperState::from_entropy(&SeededEntropy(2));
        assert_ne!(first.fresh_look_id(), second.fresh_look_id());
    }

    #[test]
    fn default_helper_states_mint_distinct_look_generations_smoke() {
        // Probabilistic smoke test of real production randomness: two 64-bit keyed
        // hashes collide with probability ~2^-64. Determinism lives in the test above.
        let mut first = HelperState::default();
        let mut second = HelperState::default();
        assert_ne!(first.look_generation, second.look_generation);
        assert_ne!(first.fresh_look_id(), second.fresh_look_id());
    }

    #[test]
    fn restored_text_ref_cannot_resolve_after_helper_restart() {
        let mut first = HelperState::new(10);
        let old_id = first.fresh_look_id();
        first.insert_look(old_id.clone(), look_with_element(1.0));
        let mut restarted = HelperState::new(20);
        let new_id = restarted.fresh_look_id();
        let mut other = look_with_element(2.0);
        other.pid = 2;
        other.hwnd = 2;
        restarted.insert_look(new_id.clone(), other);

        // Both helpers emitted their first look and can reuse the native element ref.
        assert_ne!(old_id, new_id);
        let mut read = json!({"lookId": old_id, "elementRef": "same-ref", "pid": 1, "windowId": 1});
        assert_eq!(
            read_text_element(&read, &first).unwrap().0.runtime_id,
            vec![1]
        );
        assert_eq!(
            read_text_element(&read, &restarted).unwrap_err().code,
            ErrorCode::StaleLook
        );
        read["lookId"] = json!(new_id);
        for (pid, hwnd) in [(1, 2), (2, 1)] {
            read["pid"] = json!(pid);
            read["windowId"] = json!(hwnd);
            assert_eq!(
                read_text_element(&read, &restarted).unwrap_err().code,
                ErrorCode::StaleLook
            );
        }
        read["windowId"] = json!(2);
        assert_eq!(
            read_text_element(&read, &restarted).unwrap().0.runtime_id,
            vec![2]
        );
    }

    /// Run one owner-bound wait with scripted owner answers and a fake UIA walk.
    fn scripted_wait(
        args: Value,
        owners: &[Option<u64>],
        walk: impl FnMut() -> Result<Vec<Value>, String>,
    ) -> (Result<Value, ProtocolError>, usize) {
        scripted_instance_wait(
            wait_state(Some(owned_by(7))),
            args,
            &owned_by_all(owners),
            walk,
        )
    }

    /// Helper state holding look `look` of window 22 in PID 7 and root ref `@w22` of
    /// that window, bound to `saved` (`None`: listed but never admitted).
    fn wait_state(saved: Option<WindowInstance>) -> HelperState {
        let mut state = HelperState::new(1);
        let mut look = look_with_element(5.0);
        look.pid = 7;
        look.hwnd = 22;
        look.instance = owned_by(7);
        state.insert_look("look".to_owned(), look);
        state.root_instances.insert("@w22".to_owned(), (22, saved));
        state
    }

    /// Run one owner-bound wait against `state` with scripted window instances.
    fn scripted_instance_wait(
        state: HelperState,
        args: Value,
        owners: &[Option<WindowInstance>],
        mut walk: impl FnMut() -> Result<Vec<Value>, String>,
    ) -> (Result<Value, ProtocolError>, usize) {
        let mut owners = owners.iter().copied();
        let mut walks = 0;
        let result = handle_wait_for_with(
            &args,
            &Mutex::new(state),
            || true,
            |hwnd| {
                assert_eq!(hwnd, 22);
                owners.next().expect("unexpected additional owner check")
            },
            |hwnd| {
                assert_eq!(hwnd, 22);
                Ok(())
            },
            |()| {
                walks += 1;
                walk()
            },
        );
        (result, walks)
    }

    #[test]
    fn wait_checks_owner_again_before_every_poll() {
        for next_owner in [Some(8), None] {
            for gone in [false, true] {
                // The first poll stays owned and unsatisfied; the next poll's first check drifts.
                let (result, walks) = scripted_wait(
                    json!({"pid": 7, "windowId": 22, "rootRef": "@w22", "text": "Ready", "gone": gone}),
                    &[Some(7), Some(7), Some(7), next_owner],
                    || {
                        Ok(if gone {
                            vec![json!({"name": "Ready"})]
                        } else {
                            vec![]
                        })
                    },
                );
                assert_eq!(result.unwrap_err().code, ErrorCode::RootStale);
                assert_eq!(walks, 1, "UIA must not walk the stale HWND");
            }
        }
    }

    #[test]
    fn wait_refuses_a_same_hwnd_same_pid_replacement_window() {
        let plain = json!({"pid": 7, "windowId": 22, "rootRef": "@w22", "text": "Ready"});
        let mut looked = plain.clone();
        looked["lookId"] = json!("look");
        for replacement in replacements_of(7) {
            for args in [plain.clone(), looked.clone()] {
                for gone in [false, true] {
                    let mut args = args.clone();
                    args["gone"] = json!(gone);
                    // A satisfied walk of the replacement must not report success.
                    let walk = || {
                        Ok(if gone {
                            vec![]
                        } else {
                            vec![json!({"name": "Ready"})]
                        })
                    };
                    for owners in [
                        vec![Some(replacement)],
                        vec![Some(owned_by(7)), Some(replacement)],
                        vec![Some(owned_by(7)), Some(owned_by(7)), Some(replacement)],
                    ] {
                        let walked = usize::from(owners.len() == 3);
                        let (result, walks) = scripted_instance_wait(
                            wait_state(Some(owned_by(7))),
                            args.clone(),
                            &owners,
                            walk,
                        );
                        assert_eq!(result.unwrap_err().code, ErrorCode::RootStale);
                        assert_eq!(walks, walked);
                    }
                }
            }
        }
    }

    #[test]
    fn wait_without_a_look_requires_the_root_ref_bound_to_an_admitted_instance() {
        let ready = || Ok(vec![json!({"name": "Ready"})]);
        let plain = |root_ref: &str| json!({"pid": 7, "windowId": 22, "rootRef": root_ref, "text": "Ready"});
        // Listed but never admitted, or admitted for another PID.
        for (saved, admitted) in [(None, false), (Some(owned_by(8)), true)] {
            let (result, walks) =
                scripted_instance_wait(wait_state(saved), plain("@w22"), &[], ready);
            let error = result.unwrap_err();
            assert_eq!(error.code, ErrorCode::RootStale);
            assert_eq!(error.message, window::unverified_instance(admitted).message);
            assert_eq!(walks, 0);
        }
        // A ref no longer saved (the window was rediscovered as a replacement), a ref
        // of another window, or none at all never falls back to the HWND's binding.
        let mut other_window = wait_state(Some(owned_by(7)));
        other_window
            .root_instances
            .insert("@w23".to_owned(), (23, Some(owned_by(7))));
        for (state, args) in [
            (wait_state(Some(owned_by(7))), plain("@w21")),
            (other_window, plain("@w23")),
        ] {
            let (result, walks) = scripted_instance_wait(state, args, &[], ready);
            let error = result.unwrap_err();
            assert_eq!(error.code, ErrorCode::RootStale);
            assert_eq!(error.message, window::STALE_INSTANCE);
            assert_eq!(walks, 0);
        }
        let (result, _) = scripted_instance_wait(
            wait_state(Some(owned_by(7))),
            json!({"pid": 7, "windowId": 22, "text": "Ready"}),
            &[],
            ready,
        );
        assert_eq!(result.unwrap_err().code, ErrorCode::InvalidRequest);
        let (result, walks) = scripted_instance_wait(
            wait_state(Some(owned_by(7))),
            plain("@w22"),
            &[Some(owned_by(7)); 3],
            ready,
        );
        assert_eq!(result.unwrap()["found"], json!(true));
        assert_eq!(walks, 1);
        // The look binds its own instance even when no saved root does.
        let (result, walks) = scripted_instance_wait(
            wait_state(None),
            json!({"pid": 7, "windowId": 22, "lookId": "look", "text": "Ready"}),
            &[Some(owned_by(7)); 3],
            ready,
        );
        assert_eq!(result.unwrap()["found"], json!(true));
        assert_eq!(walks, 1);
    }

    #[test]
    fn uia_refusals_across_a_replacement_report_root_stale() {
        // UIA resolution returns the instance refusal as a string; never a stale element.
        let error = stale_ref_from_uia(window::STALE_INSTANCE.to_owned());
        assert_eq!(error.code, ErrorCode::RootStale);
        assert_eq!(error.message, window::STALE_INSTANCE);
        let element = stale_ref_from_uia("Element reference is stale".to_owned());
        assert_eq!(element.code, ErrorCode::StaleRef);
    }

    /// A discovered root whose ref was issued for `(hwnd, generation)`.
    fn issued_root(state: &mut HelperState, hwnd: isize, pid: u64, generation: usize) -> Value {
        let root_ref = state
            .store
            .insert_window(NativeHandle::new(hwnd), generation)
            .to_string();
        json!({"windowId": hwnd, "pid": pid, "kind": "window", "title": "t", "rootRef": root_ref})
    }

    #[test]
    fn saved_roots_bind_only_the_instance_their_ref_was_issued_for() {
        let mut state = HelperState::new(1);
        let replaced = WindowInstance {
            token: owned_by(7).token + 1,
            ..owned_by(7)
        };
        let roots = vec![
            issued_root(&mut state, 21, 7, owned_by(7).token),
            issued_root(&mut state, 22, 7, owned_by(7).token),
            issued_root(&mut state, 23, 9, owned_by(9).token),
            issued_root(&mut state, 24, 7, owned_by(7).token),
            issued_root(&mut state, 25, 7, 0),
        ];
        let refs = roots
            .iter()
            .map(|root| root["rootRef"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        let mut read = Vec::new();
        state.save_roots(None, roots, |hwnd| {
            read.push(hwnd);
            // 22 changed owner and 24 was replaced after enumeration, 23 is
            // unreadable and 25 was listed without an admitted tag.
            match hwnd {
                21 | 25 => Some(owned_by(7)),
                22 => Some(owned_by(8)),
                24 => Some(replaced),
                _ => None,
            }
        });
        assert_eq!(read, [21, 22, 23, 24, 25]);
        assert_eq!(state.roots.len(), 5, "unbound roots stay listed");
        let bindings = |state: &HelperState| {
            let mut bindings = state
                .root_instances
                .iter()
                .map(|(root_ref, binding)| (root_ref.clone(), *binding))
                .collect::<Vec<_>>();
            bindings.sort_by(|a, b| a.0.cmp(&b.0));
            bindings
        };
        assert_eq!(
            bindings(&state),
            [
                (refs[0].clone(), (21, Some(owned_by(7)))),
                (refs[1].clone(), (22, None)),
                (refs[2].clone(), (23, None)),
                (refs[3].clone(), (24, None)),
                (refs[4].clone(), (25, None)),
            ]
        );

        // A PID-scoped rediscovery of a same-HWND replacement of 21 issues and binds a
        // new ref; the old ref no longer denotes anything, PID 9 stays untouched.
        let replacement = issued_root(&mut state, 21, 7, replaced.token);
        let new_ref = replacement["rootRef"].as_str().unwrap().to_owned();
        assert_ne!(new_ref, refs[0]);
        state.save_roots(Some(7), vec![replacement], |_| Some(replaced));
        assert_eq!(
            bindings(&state),
            [
                (refs[2].clone(), (23, None)),
                (new_ref.clone(), (21, Some(replaced))),
            ]
        );
        let admitted = AdmittedRoot { hwnd: 21, pid: 7 };
        assert_eq!(
            admitted
                .admitted_instance(&state, None, Some(&new_ref))
                .unwrap(),
            replaced
        );
        let error = admitted
            .admitted_instance(&state, None, Some(&refs[0]))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::RootStale);
        assert_eq!(error.message, window::STALE_INSTANCE);

        // Full rediscovery drops every root no longer listed.
        state.save_roots(None, vec![], |_| None);
        assert!(state.roots.is_empty());
        assert!(state.root_instances.is_empty());
    }

    #[test]
    fn wait_refuses_a_replacement_root_before_walking_it() {
        // Owned at the pre-check, replaced by the time ElementFromHandle returned.
        let (result, walks) = scripted_wait(
            json!({"pid": 7, "windowId": 22, "rootRef": "@w22", "text": "Ready"}),
            &[Some(7), Some(8)],
            || panic!("must not walk a replacement root"),
        );
        assert_eq!(result.unwrap_err().code, ErrorCode::RootStale);
        assert_eq!(walks, 0);
    }

    #[test]
    fn wait_discards_a_satisfied_walk_when_ownership_changed_during_it() {
        for gone in [false, true] {
            for after in [Some(8), None] {
                let (result, walks) = scripted_wait(
                    json!({"pid": 7, "windowId": 22, "rootRef": "@w22", "text": "Ready", "gone": gone}),
                    &[Some(7), Some(7), after],
                    || {
                        Ok(if gone {
                            vec![]
                        } else {
                            vec![json!({"name": "Ready"})]
                        })
                    },
                );
                assert_eq!(result.unwrap_err().code, ErrorCode::RootStale);
                assert_eq!(walks, 1);
            }
        }
        // A UIA failure across an owner change is drift, not an internal error.
        let (result, _) = scripted_wait(
            json!({"pid": 7, "windowId": 22, "rootRef": "@w22", "text": "Ready"}),
            &[Some(7), Some(7), None],
            || Err("provider gone".to_owned()),
        );
        assert_eq!(result.unwrap_err().code, ErrorCode::RootStale);
    }

    #[test]
    fn wait_reports_a_satisfied_walk_while_the_owner_holds() {
        let (result, walks) = scripted_wait(
            json!({"pid": 7, "windowId": 22, "rootRef": "@w22", "text": "Ready"}),
            &[Some(7), Some(7), Some(7)],
            || Ok(vec![json!({"name": "Ready"})]),
        );
        assert_eq!(result.unwrap()["found"], json!(true));
        assert_eq!(walks, 1);
        let (result, _) = scripted_wait(
            json!({"pid": 7, "windowId": 22, "rootRef": "@w22", "text": "Ready"}),
            &[Some(7), Some(7), Some(7)],
            || Err("provider failure".to_owned()),
        );
        assert_eq!(result.unwrap_err().code, ErrorCode::InternalError);
    }

    #[test]
    fn scoped_wait_matches_role_and_value_below_the_owned_scope() {
        let walk = || {
            Ok(vec![
                json!({"runtimeId": [5], "parentRuntimeId": [1], "role": "group", "name": "Panel"}),
                json!({"runtimeId": [6], "parentRuntimeId": [5], "role": "edit", "name": "Status", "value": " Done "}),
                json!({"runtimeId": [9], "parentRuntimeId": [1], "role": "edit", "name": "Status", "value": "Done"}),
                json!({"role": "edit", "name": "Status", "value": "Done"}),
            ])
        };
        let args = json!({"pid": 7, "windowId": 22, "lookId": "look", "scopeRef": "same-ref", "text": "status", "role": "edit", "value": "done"});
        let (result, walks) = scripted_wait(args.clone(), &[Some(7), Some(7), Some(7)], walk);
        assert_eq!(result.unwrap()["found"], json!(true));
        assert_eq!(walks, 1);

        // An exact scope excludes the descendant, so the matching element is gone.
        let mut exact = args;
        exact["scopeExact"] = json!(true);
        exact["gone"] = json!(true);
        let (result, walks) = scripted_wait(exact, &[Some(7), Some(7), Some(7)], walk);
        assert_eq!(result.unwrap()["gone"], json!(true));
        assert_eq!(walks, 1);
    }

    #[test]
    fn wait_refuses_to_infer_an_admitted_hwnd_or_pid() {
        for missing_identity in [
            json!({"pid": 7, "rootRef": "win:22", "text": "Ready"}),
            json!({"windowId": 22, "text": "Ready"}),
        ] {
            let error = handle_wait_for_with(
                &missing_identity,
                &Mutex::new(wait_state(Some(owned_by(7)))),
                || panic!("must not poll an unbound wait"),
                |_| panic!("must not infer the owner"),
                |_| -> Result<(), String> { panic!("must not query UIA") },
                |()| panic!("must not walk UIA"),
            )
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidRequest);
        }
    }

    #[test]
    fn scoped_wait_refuses_a_look_from_another_root_before_uia() {
        for (pid, hwnd) in [(8, 22), (7, 23), (8, 23)] {
            let error = handle_wait_for_with(
                &json!({"pid": pid, "windowId": hwnd, "lookId": "look", "scopeRef": "same-ref", "text": "Ready"}),
                &Mutex::new(wait_state(Some(owned_by(7)))),
                || panic!("must not poll a mismatched scope"),
                |_| panic!("must not check the owner of a mismatched scope"),
                |_| -> Result<(), String> { panic!("must not query UIA for a mismatched scope") },
                |()| panic!("must not walk UIA for a mismatched scope"),
            )
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::StaleLook);
        }
    }

    #[test]
    fn observation_ownership_is_explicit_and_bounded() {
        let mut state = HelperState::default();
        state.insert_look("look-a".to_owned(), look_with_element(1.0));
        state.insert_look("look-b".to_owned(), look_with_element(2.0));
        let owner = AdmittedRoot { hwnd: 1, pid: 1 };
        assert_eq!(
            owner
                .owned_look(&state, "look-a")
                .and_then(|look| look.element("same-ref"))
                .unwrap()
                .runtime_id,
            vec![1]
        );
        assert_eq!(
            owner
                .owned_look(&state, "look-b")
                .and_then(|look| look.element("same-ref"))
                .unwrap()
                .runtime_id,
            vec![2]
        );
        for index in 0..MAX_LOOK_RECORDS {
            state.insert_look(format!("new-{index}"), look_with_element(index as f64));
        }
        assert_eq!(state.looks.len(), MAX_LOOK_RECORDS);
        assert_eq!(
            owner.owned_look(&state, "look-a").unwrap_err().code,
            ErrorCode::StaleLook
        );
    }

    #[test]
    fn outline_nesting_uses_native_parentage() {
        let nodes = vec![
            (
                "1".to_owned(),
                String::new(),
                json!({"title":"parent","children":[]}),
            ),
            (
                "2".to_owned(),
                "1".to_owned(),
                json!({"title":"child","children":[]}),
            ),
        ];
        let nested = nest_outline_nodes(&nodes);
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0]["children"][0]["title"], "child");
    }

    #[test]
    fn scoped_outline_preserves_the_parent_wire_ref() {
        let outline = json!({
            "ref": "@w1",
            "children": [{ "ref": "win:look-2:@e1", "title": "scope", "children": [{ "ref": "win:look-2:@e2" }] }]
        });
        let scoped = scoped_outline_root(outline, "win:look-1:@e9");
        assert_eq!(scoped["ref"], "win:look-1:@e9");
        assert_eq!(scoped["children"][0]["ref"], "win:look-2:@e2");
    }

    #[test]
    fn observed_patterns_cannot_skip_a_foreground_batch_lease() {
        let request = json!({"lookId":"look","action":"press","policy":"foreground","target":{"ref":"same-ref"},"params":{}});
        assert!(action_may_use_physical_input(&request), "a live pattern can disappear after observation; reserve the whole foreground batch before that decision");
    }

    #[test]
    fn batch_locking_reserves_every_foreground_policy() {
        let native_press = json!({"lookId":"look","action":"press","policy":"default","target":{"ref":"same-ref"},"params":{}});
        assert!(!action_may_use_physical_input(&native_press));
        let foreground_press = json!({"lookId":"look","action":"press","policy":"foreground","target":{"ref":"same-ref"},"params":{}});
        assert!(action_may_use_physical_input(&foreground_press));
        let ax_only = json!({"lookId":"look","action":"press","policy":"ax_only","target":{"ref":"same-ref"},"params":{}});
        assert!(!action_may_use_physical_input(&ax_only));
        let coordinates = json!({"lookId":"look","action":"click","policy":"foreground","target":{"x":1,"y":2},"params":{}});
        assert!(action_may_use_physical_input(&coordinates));
    }

    #[test]
    fn event_journal_preserves_transient_roots_absent_from_final_snapshot() {
        let before = snap(vec![root(1, 1, "Editor", true)], Some(1));
        let after = before.clone();
        let events = vec![
            json!({"change":"appeared","kind":"menu","title":"File","pid":1}),
            json!({"change":"closed","kind":"menu","title":"File","pid":1}),
        ];
        let delta = combined_root_delta(&before, &after, 1, events);
        assert_eq!(delta.len(), 2);
        assert_eq!(delta[0]["change"], "appeared");
        assert_eq!(delta[1]["change"], "closed");
    }
}
