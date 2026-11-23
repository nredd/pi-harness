use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use linux_bridge::atspi::{
    outline_json, root_json, AccessibleRef, AtspiClient, NodeSnapshot, Rect, RootSnapshot,
    Snapshot, TEXT,
};
use linux_bridge::protocol::PROTOCOL_VERSION;
use linux_bridge::state::{fresh_state_id, HelperState};
use linux_bridge::wayland::{PortalCapabilities, PortalClient, PortalError};
use linux_bridge::x11::{self, Input, InputSink, InputState, PhysicalPolicy, SessionKind};
use linux_bridge::{ErrorCode, ProtocolError, Request, Response};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Semaphore};

const REQUEST_WORKERS: usize = 8;
/// How long an exiting helper tries to settle owed releases on a fresh connection; the
/// client allows 750 ms between SIGTERM and SIGKILL.
const EXIT_SETTLE_LIMIT: Duration = Duration::from_millis(300);
/// Exit status when releases stay unconfirmed at exit.
const EXIT_RELEASE_DEBT: i32 = 3;
/// How long an exiting helper waits for in-flight requests after shutdown began. One
/// stuck on an X11 reply that never comes cannot unwind, so the helper names what it may
/// hold and exits within the client's 750 ms SIGTERM-to-SIGKILL grace instead.
const EXIT_JOIN_LIMIT: Duration = Duration::from_millis(300);
/// How long a helper exiting past `EXIT_JOIN_LIMIT` gives replies already queued, e.g.
/// `cancelled` for requests that never started, to reach stdout before it exits anyway.
const EXIT_FLUSH_LIMIT: Duration = Duration::from_millis(200);
/// The client's SIGTERM-to-SIGKILL grace (`HELPER_TERMINATE_GRACE_MS`);
/// `tests/linux-kill-grace.test.ts` keeps the two equal.
const KILL_GRACE: Duration = Duration::from_millis(750);
// The exit past stuck requests waits out both limits; it must stay inside the grace.
const _: () =
    assert!(EXIT_JOIN_LIMIT.as_millis() + EXIT_FLUSH_LIMIT.as_millis() < KILL_GRACE.as_millis());
const DEFAULT_MAX_NODES: usize = 512;

/// An item for the stdout writer: a reply, or a marker it acknowledges once every reply
/// queued before it was written and flushed.
enum Outgoing {
    Reply(Response),
    Written(tokio::sync::oneshot::Sender<()>),
}

/// The request side of the stdout writer's queue.
#[derive(Clone)]
struct Replies(mpsc::UnboundedSender<Outgoing>);
impl Replies {
    /// Queue `response`; it is dropped if the writer already stopped.
    fn send(&self, response: Response) {
        let _ = self.0.send(Outgoing::Reply(response));
    }
    /// Queue a marker that `done` hears once every reply queued before it was written.
    /// Returns `false` if the writer already stopped: nothing more is written then.
    fn mark_written(&self, done: tokio::sync::oneshot::Sender<()>) -> bool {
        self.0.send(Outgoing::Written(done)).is_ok()
    }
}

/// Set by `drain` once it gives up on stuck requests and starts the reply flush.
static EXIT_FLUSH_BEGAN: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// In the dev-only `testing` build with `PI_CU_TESTING_HOLD_REPLIES_UNTIL_EXIT_FLUSH`
/// set, the stdout writer holds every reply until `drain` starts its flush, so a process
/// test fails if the stuck exit path stops flushing. Always `false` in the release
/// helper.
fn testing_hold_replies() -> bool {
    cfg!(feature = "testing")
        && std::env::var_os("PI_CU_TESTING_HOLD_REPLIES_UNTIL_EXIT_FLUSH").is_some()
}

/// Write each queued reply as one flushed JSON line, until the queue closes or a write
/// fails.
async fn write_replies(
    mut out: impl tokio::io::AsyncWrite + Unpin,
    mut queue: mpsc::UnboundedReceiver<Outgoing>,
) {
    let mut hold = testing_hold_replies();
    while let Some(item) = queue.recv().await {
        match item {
            Outgoing::Reply(response) => {
                if hold {
                    EXIT_FLUSH_BEGAN.notified().await;
                    hold = false;
                }
                if let Ok(mut line) = serde_json::to_vec(&response) {
                    line.push(b'\n');
                    if out.write_all(&line).await.is_err() {
                        return;
                    }
                    let _ = out.flush().await;
                }
            }
            Outgoing::Written(done) => {
                let _ = done.send(());
            }
        }
    }
}

/// How the exit wait ended.
#[derive(Debug, PartialEq, Eq)]
enum Drained {
    /// Every request finished and the writer wrote every reply.
    All,
    /// A request was still running at `EXIT_JOIN_LIMIT`.
    Stuck,
}

/// Wait for in-flight requests once shutdown began, at most `EXIT_JOIN_LIMIT`. When they
/// all finish, close the queue and wait for the writer. When one is stuck, e.g. on an X11
/// reply that never comes, give replies already queued at most `EXIT_FLUSH_LIMIT` to be
/// written, then return anyway: on that path replies are best effort, since a writer
/// blocked on stdout must not keep the helper past the client's kill grace.
async fn drain(
    requests: &mut tokio::task::JoinSet<()>,
    output: Replies,
    writer: tokio::task::JoinHandle<()>,
) -> Drained {
    let joined = tokio::time::timeout(EXIT_JOIN_LIMIT, async {
        while requests.join_next().await.is_some() {}
    })
    .await
    .is_ok();
    if joined {
        drop(output);
        let _ = writer.await;
        return Drained::All;
    }
    // `notify_one` keeps a permit for a writer not yet waiting.
    EXIT_FLUSH_BEGAN.notify_one();
    let (done, written) = tokio::sync::oneshot::channel();
    if output.mark_written(done) {
        let _ = tokio::time::timeout(EXIT_FLUSH_LIMIT, written).await;
    }
    Drained::Stuck
}

#[tokio::main(flavor = "multi_thread", worker_threads = 8)]
async fn main() {
    let state = Arc::new(Mutex::new(HelperState::default()));
    let (queue, responses) = mpsc::unbounded_channel();
    let output = Replies(queue);
    let writer = tokio::spawn(write_replies(tokio::io::stdout(), responses));

    let semaphore = Arc::new(tokio::sync::Semaphore::new(REQUEST_WORKERS));
    let mut requests = tokio::task::JoinSet::new();
    // Registered before the first read, so a SIGTERM or SIGINT from then on drains
    // instead of killing the helper between a press and its release.
    let mut shutdown = shutdown_signals();
    let (mut lines, input_closed) = stdin_lines();
    loop {
        let line = tokio::select! {
            () = shutdown.recv() => break,
            line = lines.recv() => line,
        };
        let Some(line) = line else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        let id = extract_id(&line).unwrap_or_else(|| "unknown".to_owned());
        let request = match serde_json::from_str::<Request>(&line) {
            Ok(request) => request,
            Err(error) => {
                output.send(Response::err(
                    &id,
                    ProtocolError::new(
                        format!("Invalid request: {error}"),
                        ErrorCode::InvalidRequest,
                    ),
                ));
                continue;
            }
        };
        let saturated = semaphore.available_permits() == 0;
        if saturated {
            testing_ready("saturated", &request.id);
        }
        // Every worker may be busy behind a long action, or stuck on a stalled X server: a
        // signal, stdin EOF or a read error must still cancel it now, not once a worker
        // frees up. A free worker is taken first, so lines read before EOF still start.
        let permit = tokio::select! {
            biased;
            permit = semaphore.clone().acquire_owned() => permit,
            () = shutdown.recv() => {
                output.send(Response::err(&request.id, shutting_down()));
                break;
            }
            () = input_closed.notified() => {
                output.send(Response::err(&request.id, shutting_down()));
                break;
            }
        };
        let Ok(permit) = permit else {
            break;
        };
        // Shutdown, e.g. stdin EOF, may have begun while this request waited for a
        // worker: it never started, so it does not start now.
        if saturated && InputState::shared().is_cancelled() {
            output.send(Response::err(&request.id, shutting_down()));
            continue;
        }
        let state = Arc::clone(&state);
        let output = output.clone();
        requests.spawn(async move {
            let _permit = permit;
            let response = handle_request(&state, &request).await;
            output.send(response);
        });
    }
    // Stdin EOF, a read error or a signal: stop physical input before its next unit.
    // An in-flight action runs its owed releases and replies; then the helper exits.
    InputState::shared().cancel();
    // Requests read but never started are answered, not dropped: none of them ran.
    while let Ok(line) = lines.try_recv() {
        if let Some(id) = extract_id(&line) {
            output.send(Response::err(&id, shutting_down()));
        }
    }
    if drain(&mut requests, output, writer).await == Drained::Stuck {
        // A stuck request still holds whatever it pressed: its press was registered
        // before submission, so name it and every owed release, then leave.
        std::process::exit(exit_status(InputState::shared().possibly_held()));
    }
    // Tokio's stdin reads on a blocking thread that runtime shutdown would wait on
    // until EOF; every reply is written, so leave now.
    std::process::exit(settle_before_exit().await);
}

/// Try once, bounded, to confirm owed releases on a fresh X11 connection. Returns the
/// exit status: nonzero, with the releases named on stderr, while any stay owed. Nothing
/// records them past this exit, so the client must refuse physical input from then on.
async fn settle_before_exit() -> i32 {
    let left = tokio::task::spawn_blocking(|| {
        x11::exit_settlement(InputState::shared(), EXIT_SETTLE_LIMIT)
    })
    .await
    // The settlement catches its own panics; a join failure leaves the debt as it was.
    .unwrap_or_else(|_| InputState::shared().unconfirmed_releases());
    exit_status(left)
}

/// The exit status for inputs that may stay held: 0 for none, else
/// `EXIT_RELEASE_DEBT` with them named on stderr for the client.
fn exit_status(held: Vec<String>) -> i32 {
    if held.is_empty() {
        return 0;
    }
    eprintln!(
        "linux-bridge: exiting with the release of {} unconfirmed; it may still be held. Release it by hand, then restart Pi.",
        held.join(", ")
    );
    EXIT_RELEASE_DEBT
}

/// Read stdin lines on their own task, so EOF is seen even while every worker is busy
/// and the request loop waits for one. EOF or a read error cancels physical input at
/// once and fires the returned notification, which wakes a request waiting for a worker
/// into shutdown; lines already read stay queued and are still answered.
fn stdin_lines() -> (mpsc::UnboundedReceiver<String>, Arc<tokio::sync::Notify>) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let closed = Arc::new(tokio::sync::Notify::new());
    let notify = Arc::clone(&closed);
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if sender.send(line).is_err() {
                return;
            }
        }
        InputState::shared().cancel();
        // Stored if nothing waits yet: the next request to wait for a worker sees it.
        notify.notify_one();
    });
    (receiver, closed)
}

fn shutting_down() -> ProtocolError {
    ProtocolError::new(
        "Helper is shutting down; the request did not run",
        ErrorCode::Cancelled,
    )
}

/// SIGTERM and SIGINT, merged. A signal that cannot be registered keeps its default.
struct ShutdownSignals {
    terminate: Option<tokio::signal::unix::Signal>,
    interrupt: Option<tokio::signal::unix::Signal>,
}
impl ShutdownSignals {
    async fn recv(&mut self) {
        async fn next(signal: &mut Option<tokio::signal::unix::Signal>) {
            match signal {
                Some(signal) => {
                    signal.recv().await;
                }
                None => std::future::pending().await,
            }
        }
        tokio::select! {
            () = next(&mut self.terminate) => {}
            () = next(&mut self.interrupt) => {}
        }
    }
}
fn shutdown_signals() -> ShutdownSignals {
    use tokio::signal::unix::{signal, SignalKind};
    ShutdownSignals {
        terminate: signal(SignalKind::terminate()).ok(),
        interrupt: signal(SignalKind::interrupt()).ok(),
    }
}

fn action_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Wait for the action lock: actions and batches run one at a time. Any request that
/// holds the lock once shutdown began answers `cancelled` without starting, whether it
/// waited or got the lock at once, semantic (AT-SPI) actions included: nothing admitted
/// after cancellation began may mutate the desktop.
async fn begin_transaction(
    id: &str,
    input: &InputState,
) -> Result<tokio::sync::MutexGuard<'static, ()>, ProtocolError> {
    testing_ready("waiting", id);
    let guard = action_lock().lock().await;
    testing_ready("locked", id);
    admit_mutation(input)?;
    Ok(guard)
}

/// Refuse a desktop mutation (action, focus, browser launch) once shutdown began.
fn admit_mutation(input: &InputState) -> Result<(), ProtocolError> {
    if input.is_cancelled() {
        return Err(shutting_down());
    }
    Ok(())
}

/// Report a scheduling point on stderr, so process tests establish their preconditions
/// (lock held, queue saturated) instead of sleeping. Only in the dev-only `testing`
/// build; a no-op in the release helper.
fn testing_ready(event: &str, id: &str) {
    if cfg!(feature = "testing") {
        eprintln!("linux-bridge testing: {event} {id}");
    }
}

fn extract_id(line: &str) -> Option<String> {
    serde_json::from_str::<Value>(line)
        .ok()?
        .get("id")?
        .as_str()
        .map(str::to_owned)
}

async fn handle_request(state: &Arc<Mutex<HelperState>>, request: &Request) -> Response {
    handle_request_with(
        state,
        request,
        &InputState::shared(),
        AtspiClient::connect,
        physical_act,
    )
    .await
}

/// Answer `request`; `input` carries the shutdown flag mutations are admitted against.
async fn handle_request_with(
    state: &Arc<Mutex<HelperState>>,
    request: &Request,
    input: &InputState,
    connect: impl AsyncFn() -> Result<AtspiClient, ProtocolError>,
    physical: PhysicalAct,
) -> Response {
    if request.protocol_version != PROTOCOL_VERSION {
        return Response::err(
            &request.id,
            invalid(format!(
                "Unsupported Linux helper protocol {}; expected {}. Restart Pi to use the installed helper.",
                request.protocol_version, PROTOCOL_VERSION
            )),
        );
    }
    let result = match request.cmd.as_str() {
        "diagnostics" => Ok(diagnostics().await),
        "listRoots" | "listWindows" => list_roots(state, &request.args).await,
        "look" | "screenshot" => {
            look_with(state, &request.args, &connect, x11::capture_window).await
        }
        "act" => match begin_transaction(&request.id, input).await {
            Ok(_transaction) => act(state, &request.args, &connect, physical).await,
            Err(error) => Err(error),
        },
        "actBatch" => match begin_transaction(&request.id, input).await {
            Ok(_transaction) => {
                act_batch_with(
                    &request.args,
                    || input.is_cancelled(),
                    |args| act(state, args, &connect, physical),
                )
                .await
            }
            Err(error) => Err(error),
        },
        #[cfg(feature = "testing")]
        "testingAct" => match begin_transaction(&request.id, input).await {
            Ok(_transaction) => {
                let args = request.args.clone();
                off_worker(move || testing_act(&args)).await
            }
            Err(error) => Err(error),
        },
        #[cfg(feature = "testing")]
        "testingStall" => testing_stall(&request.id, &request.args).await,
        "atspiReadText" | "uiaReadText" | "axReadText" => {
            read_text_with(state, &request.args, async |root, accessible| {
                connect().await?.read_live_text(root, accessible).await
            })
            .await
        }
        "atspiLookRoot" => {
            look_root(
                state,
                &request.args,
                &connect,
                x11::list_display_windows,
                &X11_ENRICHMENT,
            )
            .await
        }
        "atspiWaitFor" | "uiaWaitFor" | "axWaitFor" => {
            wait_for(state, &request.args, &connect).await
        }
        "focusWindow" => match admit_mutation(input) {
            Ok(()) => focus_window(state, &request.args).await,
            Err(error) => Err(error),
        },
        "openBrowserLocation" => {
            admit_mutation(input).and_then(|()| open_browser_location(&request.args))
        }
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

async fn diagnostics() -> Value {
    diagnostics_with(x11::available).await
}

/// [`diagnostics`] with the X11 availability probe `x11_probe`, run off the request workers;
/// a probe that did not finish reports X11 unavailable.
async fn diagnostics_with(x11_probe: impl FnOnce() -> bool + Send + 'static) -> Value {
    let accessibility = AtspiClient::available().await;
    let session = SessionKind::detect();
    let x11_available = off_worker(move || Ok(x11_probe())).await.unwrap_or(false);
    let wayland_portal = if session == SessionKind::Wayland {
        let probe = match PortalClient::connect().await {
            Ok(client) => client.probe().await,
            Err(error) => Err(error),
        };
        portal_diagnostics(Some(probe))
    } else {
        portal_diagnostics(None)
    };
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "architectureVersion": 1,
        "invariants": [
            "state-scoped-observations",
            "bounded-observation-history",
            "multi-root-forest",
            "progressive-disclosure",
            "atomic-physical-input",
            "concurrent-requests",
            "transactional-batching"
        ],
        "pid": std::process::id(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "backend": if x11_available { "at-spi2+x11" } else { "at-spi2" },
        "sessionType": session.as_str(),
        "x11": x11_available,
        "accessibility": accessibility,
        "screenRecording": x11_available,
        "coordinateInput": x11_available,
        "waylandPortal": wayland_portal,
        "capabilities": {
            "roots": accessibility,
            "outline": accessibility,
            "readText": accessibility,
            "waitFor": accessibility,
            "semanticPress": accessibility,
            "semanticSetText": accessibility,
            "screenshots": x11_available,
            "coordinates": x11_available,
            "forceFocus": x11_available
        }
    })
}

fn portal_diagnostics(probe: Option<Result<PortalCapabilities, PortalError>>) -> Value {
    match probe {
        Some(Ok(capabilities)) => json!({
            "probed": true,
            "available": true,
            "interactiveUseEnabled": false,
            "readOnlyProbe": true,
            "remoteDesktopVersion": capabilities.remote_desktop_version,
            "screenCastVersion": capabilities.screen_cast_version,
            "availableDeviceTypes": capabilities.available_device_types,
            "availableSourceTypes": capabilities.available_source_types,
            "availableCursorModes": capabilities.available_cursor_modes,
        }),
        Some(Err(error)) => json!({
            "probed": true,
            "available": false,
            "interactiveUseEnabled": false,
            "readOnlyProbe": true,
            "error": {
                "kind": "portal_unavailable",
                "message": error.to_string(),
            },
        }),
        None => json!({
            "probed": false,
            "available": false,
            "interactiveUseEnabled": false,
            "readOnlyProbe": true,
            "reason": "not_wayland",
        }),
    }
}

async fn list_roots(state: &Arc<Mutex<HelperState>>, args: &Value) -> Result<Value, ProtocolError> {
    list_roots_with(
        state,
        args,
        AtspiClient::connect,
        x11::list_display_windows,
        &X11_ENRICHMENT,
    )
    .await
}

/// The AT-SPI root inventory, each root's X11 class evidence read through `enrichment` like
/// [`look_root`]'s, and reported per root as `metadata.x11Pairing` with the same values: a
/// failed, timed-out or still-stuck listing is `unavailable` for every root, never a clean
/// check, so discovery cannot admit a class-blocked window while the X server stalls (#1311).
/// `pid` scopes it to one process, `pids` to several in one request and one X11 listing,
/// e.g. every app a `find_roots` filter matched: one listing per app would queue behind a
/// stalled X server for longer than the client waits.
async fn list_roots_with(
    state: &Arc<Mutex<HelperState>>,
    args: &Value,
    connect: impl AsyncFnOnce() -> Result<AtspiClient, ProtocolError>,
    windows: impl FnOnce() -> Result<Option<Vec<x11::WindowInfo>>, ProtocolError> + Send + 'static,
    enrichment: &Enrichment,
) -> Result<Value, ProtocolError> {
    let pids = match args.get("pids") {
        Some(pids) => Some(
            pids.as_array()
                .filter(|pids| !pids.is_empty())
                .and_then(|pids| pids.iter().map(Value::as_u64).collect::<Option<Vec<_>>>())
                .ok_or_else(|| {
                    ProtocolError::new(
                        "listRoots pids must be a non-empty array of process IDs",
                        ErrorCode::InvalidRequest,
                    )
                })?,
        ),
        None => args.get("pid").and_then(Value::as_u64).map(|pid| vec![pid]),
    };
    let mut roots = connect().await?.list_roots(pids.as_deref()).await?;
    let pairings = match bounded(enrichment, windows).await {
        Some(Ok(Some(windows))) => x11::enrich_roots(&mut roots, &windows)
            .into_iter()
            .map(x11::Pairing::as_str)
            .collect(),
        Some(Ok(None)) => vec!["absent"; roots.len()],
        _ => vec!["unavailable"; roots.len()],
    };
    let stored = lock(state)?.replace_roots(roots);
    let windows = stored
        .iter()
        .zip(pairings)
        .enumerate()
        .map(|(index, ((reference, root), pairing))| {
            let mut json = root_json(reference, root, index);
            json["metadata"]["x11Pairing"] = json!(pairing);
            json
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "stateId": fresh_state_id(),
        "windows": windows,
        "roots": windows
    }))
}

/// The X11 window listing that may add a class alias to a `listRoots` or `atspiLookRoot`
/// root; both share [`X11_ENRICHMENT`].
struct Enrichment {
    /// How long a request waits for the listing, its turn at the slot included.
    deadline: Duration,
    /// One permit, held from the spawn of a listing thread until its read returns: a
    /// stalled X server then holds one thread and one connection, never one per request,
    /// and requests in the meantime wait at most `deadline` and report `unavailable`.
    slot: &'static Semaphore,
}

static X11_ENRICHMENT_SLOT: Semaphore = Semaphore::const_new(1);
static X11_ENRICHMENT: Enrichment = Enrichment {
    deadline: Duration::from_secs(2),
    slot: &X11_ENRICHMENT_SLOT,
};

/// The live root of `lookId`'s retained look, found by the AT-SPI bus name and object path
/// the look retains, never by an inventory `@w` handle a later listing may reissue (#1300).
/// `root` is `null` only when the bounded lookup proved it absent. The owner PID and
/// executable are live, and the X11 pairing ranks against the root's own live name and
/// extents, never the frame or title an earlier pairing saved in the look. The X11 listing
/// gets `enrichment`'s deadline at most, and one listing runs at a time. `metadata.x11Pairing` says how it went: `paired`, `ambiguous`
/// (tied windows' classes are block-only aliases), `unpaired`, `absent` (no X display, so no
/// class evidence exists) or `unavailable` (the listing failed or timed out, so class
/// evidence is missing, which the bridge refuses as `inventory_incomplete`; so is a lookup
/// made while an earlier listing is still stuck).
async fn look_root(
    state: &Arc<Mutex<HelperState>>,
    args: &Value,
    connect: impl AsyncFnOnce() -> Result<AtspiClient, ProtocolError>,
    windows: impl FnOnce() -> Result<Option<Vec<x11::WindowInfo>>, ProtocolError> + Send + 'static,
    enrichment: &Enrichment,
) -> Result<Value, ProtocolError> {
    let look_id = required_str(args, "lookId", "atspiLookRoot requires lookId")?;
    let mut root = lock(state)?.look(look_id)?.root;
    let Some(live) = connect().await?.exact_root(&root.accessible).await? else {
        return Ok(json!({ "root": Value::Null }));
    };
    root = RootSnapshot {
        pid: live.pid,
        executable: live.executable,
        name: live.name,
        frame: live.frame,
        wm_class: None,
        class_candidates: Vec::new(),
        x11_window: None,
        is_focused: false,
        is_minimized: false,
        z_order: None,
        ..root
    };
    let pairing = match bounded(enrichment, windows).await {
        Some(Ok(Some(windows))) => {
            x11::enrich_roots(std::slice::from_mut(&mut root), &windows)[0].as_str()
        }
        Some(Ok(None)) => "absent",
        _ => "unavailable",
    };
    let reference = lock(state)?.root_ref(&root.accessible).unwrap_or_default();
    let mut json = root_json(&reference, &root, 0);
    json["metadata"]["x11Pairing"] = json!(pairing);
    Ok(json!({ "root": json }))
}

/// Run a blocking `read` on its own thread once `enrichment`'s slot is free, all before one
/// absolute deadline `enrichment.deadline` from the call; `None` past it. Concurrent
/// requests (e.g. a look-root lookup and a `listRoots`) take turns rather than fail. A read
/// still blocked is left behind rather than awaited, so it cannot hold the reply, and keeps
/// the slot until it returns, so a stuck X server never accumulates threads: later requests
/// time out waiting, spawning none.
///
/// A timer polls its future first, so a task resumed late can find the permit or the reply
/// ready after the deadline passed: the deadline is checked again after the permit, before
/// any spawn, and after the reply, which is refused once observed past it.
async fn bounded<T: Send + 'static>(
    enrichment: &Enrichment,
    read: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let deadline = tokio::time::Instant::now() + enrichment.deadline;
    let in_time = || tokio::time::Instant::now() < deadline;
    let slot = tokio::time::timeout_at(deadline, enrichment.slot.acquire())
        .await
        .ok()?
        .ok()?;
    if !in_time() {
        return None;
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // A failed spawn drops the closure, and the permit with it.
    std::thread::Builder::new()
        .name("x11-enrichment".into())
        .spawn(move || {
            let _ = sender.send(read());
            drop(slot);
        })
        .ok()?;
    let value = tokio::time::timeout_at(deadline, receiver)
        .await
        .ok()?
        .ok()?;
    in_time().then_some(value)
}

/// Run blocking X11 work (XTEST posts, capture, focus, the availability probe) on Tokio's
/// blocking pool, never on a request worker: a stalled X server then holds blocking threads
/// only, and the workers keep reading stdin, signals and the exit deadline, so shutdown still
/// names a stuck press instead of waiting for the client's SIGKILL (#1261). At most
/// `REQUEST_WORKERS` requests run, so at most that many such threads stay stuck. See
/// [`joined`] for a panic or a cancelled task.
async fn off_worker<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ProtocolError> + Send + 'static,
) -> Result<T, ProtocolError> {
    joined(tokio::task::spawn_blocking(work).await)
}

/// The result of joined blocking work. A panic propagates to the request as it did on the
/// worker; a task Tokio cancelled (e.g. at runtime shutdown) never finished, so it is an
/// internal error rather than a second panic.
fn joined<T>(
    joined: Result<Result<T, ProtocolError>, tokio::task::JoinError>,
) -> Result<T, ProtocolError> {
    match joined {
        Ok(result) => result,
        Err(error) => match error.try_into_panic() {
            Ok(panic) => std::panic::resume_unwind(panic),
            Err(error) => Err(ProtocolError::new(
                format!("Blocking X11 work did not finish: {error}"),
                ErrorCode::InternalError,
            )),
        },
    }
}

/// Stand in for blocking X11 observation stuck on a stalled X server: announce `stalling <id>`
/// once inside the blocking call, then hold it for `args.ms`. Only in the dev-only `testing`
/// build, so process tests can occupy every request worker without a display.
#[cfg(feature = "testing")]
async fn testing_stall(id: &str, args: &Value) -> Result<Value, ProtocolError> {
    let id = id.to_owned();
    let stall = Duration::from_millis(args.get("ms").and_then(Value::as_u64).unwrap_or(0));
    off_worker(move || {
        testing_ready("stalling", &id);
        std::thread::sleep(stall);
        Ok(json!({"stalled": true}))
    })
    .await
}

async fn resolve_root(
    state: &Arc<Mutex<HelperState>>,
    args: &Value,
) -> Result<(String, RootSnapshot), ProtocolError> {
    let requested = args
        .get("rootRef")
        .or_else(|| args.get("windowRef"))
        .and_then(Value::as_str);
    if let Some(reference) = requested {
        if let Some(root) = lock(state)?.root(reference) {
            return Ok((reference.to_owned(), root));
        }
    }
    if lock(state)?.roots().is_empty() {
        list_roots(state, &json!({})).await?;
    }
    let roots = lock(state)?.roots();
    let requested_pid = args.get("pid").and_then(Value::as_u64);
    roots
        .into_iter()
        .find(|(_, root)| {
            requested.is_none() && requested_pid.map(|pid| root.pid == pid).unwrap_or(true)
        })
        .ok_or_else(|| ProtocolError::new("Root not found", ErrorCode::TargetNotFound))
}

fn initial_image_size(root: &RootSnapshot, base_size: Option<(u16, u16)>) -> (u16, u16) {
    base_size.unwrap_or_else(|| {
        root.frame
            .as_ref()
            .map(|frame| {
                (
                    frame.width.max(1).min(i32::from(u16::MAX)) as u16,
                    frame.height.max(1).min(i32::from(u16::MAX)) as u16,
                )
            })
            .unwrap_or((1, 1))
    })
}

/// The accessibility operation needed after a look has resolved its target.
trait SnapshotSource {
    /// Snapshot `root`, redacting protected nodes, or from an explicit `scope`, refusing one
    /// that is protected or whose live ancestry up to `root` is.
    async fn snapshot_within(
        &self,
        root: &AccessibleRef,
        scope: Option<&AccessibleRef>,
        max_nodes: usize,
        max_depth: usize,
    ) -> Result<Vec<NodeSnapshot>, ProtocolError>;
}

impl SnapshotSource for AtspiClient {
    async fn snapshot_within(
        &self,
        root: &AccessibleRef,
        scope: Option<&AccessibleRef>,
        max_nodes: usize,
        max_depth: usize,
    ) -> Result<Vec<NodeSnapshot>, ProtocolError> {
        let snapshot = match scope {
            Some(scope) => {
                self.snapshot_within(root, scope, max_nodes, max_depth)
                    .await?
            }
            None => self.snapshot_from(root, max_nodes, max_depth).await?,
        };
        Ok(snapshot.nodes)
    }
}

/// Assemble and store an observation using the selected accessibility and capture backends.
async fn look_with<S: SnapshotSource>(
    state: &Arc<Mutex<HelperState>>,
    args: &Value,
    connect: impl AsyncFnOnce() -> Result<S, ProtocolError>,
    capture: impl FnOnce(u32, Option<u32>) -> Result<x11::Capture, ProtocolError> + Send + 'static,
) -> Result<Value, ProtocolError> {
    let started = Instant::now();
    let (root_ref, root) = resolve_root(state, args).await?;
    let read_text = args
        .get("readText")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    if !matches!(read_text, "auto" | "always" | "never") {
        return Err(invalid("readText must be auto, always, or never"));
    }
    let max_nodes = args
        .get("maxNodes")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_MAX_NODES as u64)
        .clamp(1, 4096) as usize;
    let max_depth = args
        .get("maxDepth")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .clamp(1, 64) as usize;
    let max_dimension = args
        .get("maxDimension")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, 16_384) as u32);
    let client = connect().await?;
    let scope_ref = args.get("scopeRef").and_then(Value::as_str);
    let base_look_id = args.get("baseLookId").and_then(Value::as_str);
    let (nodes, base) = if let Some(scope_ref) = scope_ref {
        let (base, scope) = lock(state)?.scope(scope_ref, base_look_id)?;
        if base.root.accessible != root.accessible {
            return Err(ProtocolError::new(
                "Scope ref is outside the target root",
                ErrorCode::StaleRef,
            ));
        }
        (
            client
                .snapshot_within(
                    &root.accessible,
                    Some(&scope.accessible),
                    max_nodes,
                    max_depth,
                )
                .await?,
            Some(base),
        )
    } else {
        (
            client
                .snapshot_within(&root.accessible, None, max_nodes, max_depth)
                .await?,
            None,
        )
    };
    let (look_id, nodes) = lock(state)?.insert_look(root.clone(), nodes, base.as_ref());
    let mut outline = outline_json(&root, &nodes, max_nodes);
    let elapsed = started.elapsed().as_millis() as u64;
    let frame = root
        .frame
        .as_ref()
        .map(|r| json!({"x":r.x,"y":r.y,"w":r.width,"h":r.height}))
        .unwrap_or_else(|| json!({"x":0,"y":0,"w":0,"h":0}));
    let mut image_size = initial_image_size(
        &root,
        base.as_ref()
            .map(|record| (record.image_width, record.image_height)),
    );
    let image = if args
        .get("includeImage")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        match root.x11_window {
            Some(window) => {
                let shot = off_worker(move || capture(window, max_dimension)).await?;
                image_size = (shot.width, shot.height);
                Some(json!({
                    "jpegBase64": shot.png_base64, "mimeType":"image/png", "width":shot.width, "height":shot.height,
                    "metadata":{"source":shot.source,"warnings":shot.warnings}
                }))
            }
            None => None,
        }
    } else {
        None
    };
    lock(state)?.set_look_image_size(&look_id, image_size.0, image_size.1)?;
    let (scale_x, scale_y) = root
        .frame
        .as_ref()
        .map(|frame| {
            (
                f64::from(image_size.0) / f64::from(frame.width.max(1)),
                f64::from(image_size.1) / f64::from(frame.height.max(1)),
            )
        })
        .unwrap_or((1.0, 1.0));
    scale_outline_rects(&mut outline, scale_x, scale_y);
    let mut response = json!({
        "lookId": look_id,
        "capturedAt": now_seconds(),
        "window": {
            "windowId": root.x11_window,
            "rootRef": root_ref,
            "kind": "window",
            "framePoints": frame,
            "scaleFactor": scale_x,
            "isModal": root.role.to_lowercase().contains("dialog"),
            "role": root.role,
            "subrole": "",
            "metadata": {"backend":"at-spi2","imageScaleX":scale_x,"imageScaleY":scale_y}
        },
        "outline": outline,
        "timings": {"captureMs":0,"describeMs":elapsed,"readTextMs":0,"totalMs":elapsed},
        "readText": {"requested":read_text,"executed":false}
    });
    if let Some(image) = image {
        response["image"] = image;
    }
    Ok(response)
}

async fn focus_window(
    state: &Arc<Mutex<HelperState>>,
    args: &Value,
) -> Result<Value, ProtocolError> {
    focus_window_with(state, args, x11::focus_window).await
}

/// [`focus_window`] activating through `focus`, run off the request workers.
async fn focus_window_with(
    state: &Arc<Mutex<HelperState>>,
    args: &Value,
    focus: impl FnOnce(u32, PhysicalPolicy) -> Result<Value, ProtocolError> + Send + 'static,
) -> Result<Value, ProtocolError> {
    let reference = args
        .get("rootRef")
        .or_else(|| args.get("windowRef"))
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("focusWindow requires rootRef"))?;
    let policy = if args.get("policy").is_some() {
        PhysicalPolicy::parse(args.get("policy").and_then(Value::as_str))?
    } else {
        PhysicalPolicy::Foreground
    };
    // Before the root lookup: a refusal never says whether the handle exists (#1298).
    policy.refuse_strict_headless()?;
    let root = lock(state)?
        .root(reference)
        .ok_or_else(|| ProtocolError::new("Root not found", ErrorCode::TargetNotFound))?;
    let window = root
        .x11_window
        .ok_or_else(|| capability("Root is not correlated with an X11 window"))?;
    off_worker(move || focus(window, policy)).await
}

fn open_browser_location(args: &Value) -> Result<Value, ProtocolError> {
    let url = required_str(args, "url", "openBrowserLocation requires a non-empty url")?;
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|error| {
            ProtocolError::new(
                format!("Failed to launch xdg-open: {error}"),
                ErrorCode::CapabilityDeferred,
            )
        })?;
    Ok(json!({"opened": true, "delivery": "xdg-open"}))
}

type PhysicalAct = fn(
    &str,
    &Value,
    PhysicalPolicy,
    u32,
    (i32, i32),
    ActionGeometry,
) -> Result<Value, ProtocolError>;

/// Element actions `act` tries semantically (`press`, `setText`) before any physical fallback;
/// every other action, and every coordinate target, needs physical delivery.
const SEMANTIC_ACTIONS: [&str; 4] = ["press", "click", "setText", "typeText"];

/// What an `act` request targets: an outline element, or a point in its look image.
enum ActTarget<'a> {
    Element(&'a str),
    Point(f64, f64),
}

async fn act(
    state: &Arc<Mutex<HelperState>>,
    args: &Value,
    connect: impl AsyncFnOnce() -> Result<AtspiClient, ProtocolError>,
    physical: PhysicalAct,
) -> Result<Value, ProtocolError> {
    let look_id = required_str(args, "lookId", "act requires lookId")?;
    let action = required_str(args, "action", "act requires action")?;
    let target = args
        .get("target")
        .ok_or_else(|| invalid("act requires target"))?;
    let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
    let policy = PhysicalPolicy::parse(args.get("policy").and_then(Value::as_str))?;
    let target = match target.get("ref").and_then(Value::as_str) {
        Some(reference) => ActTarget::Element(reference),
        None => ActTarget::Point(
            target
                .get("x")
                .and_then(Value::as_f64)
                .ok_or_else(|| invalid("coordinate target requires x"))?,
            target
                .get("y")
                .and_then(Value::as_f64)
                .ok_or_else(|| invalid("coordinate target requires y"))?,
        ),
    };
    // Physical-only delivery is refused before any look, target or bus lookup, so neither a
    // missing target nor an unavailable bus can stand in for `foreground_required` (#1298).
    let physical_only = match target {
        ActTarget::Element(_) => !SEMANTIC_ACTIONS.contains(&action),
        ActTarget::Point(..) => true,
    };
    if physical_only {
        policy.refuse_strict_headless()?;
    }
    let record = lock(state)?.look(look_id)?;
    let client = connect().await?;

    let (x, y) = match target {
        ActTarget::Point(x, y) => (x, y),
        ActTarget::Element(reference) => {
            let node = lock(state)?.element(look_id, reference)?;
            let text = params.get("text").and_then(Value::as_str).unwrap_or("");
            let semantic = match action {
                "press" | "click" => Some(client.press(&node).await.map(|worked| (worked, None))),
                "setText" | "typeText" => Some(
                    client
                        .set_text(&node, text)
                        .await
                        .map(|worked| (worked, Some(json!({"value":text})))),
                ),
                _ => None,
            };
            match semantic {
                Some(Ok((worked, evidence))) => {
                    let mut result = json!({"outcome": if worked {"worked"} else {"didnt"}, "performed": semantic_performed()});
                    if let Some(evidence) = evidence {
                        result["evidence"] = evidence;
                    }
                    return Ok(result);
                }
                // Shutdown began before the mutation: nothing ran, and nothing may fall back.
                Some(Err(error)) if error.code == ErrorCode::Cancelled => return Err(error),
                Some(Err(error)) if error.code == ErrorCode::Timeout => {
                    return Err(ProtocolError::new(
                        format!("{}; semantic action outcome is unknown", error.message),
                        ErrorCode::Timeout,
                    ));
                }
                _ => {}
            }
            // Semantic delivery was attempted first. Only an explicitly physical-capable
            // policy may fall back to the element centre.
            policy.refuse_strict_headless()?;
            let bounds = node.bounds.ok_or_else(|| {
                ProtocolError::new(
                    "Element has no coordinate fallback",
                    ErrorCode::CoordinateUnavailableForRoot,
                )
            })?;
            let frame = record.root.frame.clone().ok_or_else(|| {
                ProtocolError::new(
                    "Root has no coordinate geometry",
                    ErrorCode::CoordinateUnavailableForRoot,
                )
            })?;
            let owning_window = record.root.x11_window.ok_or_else(|| {
                capability("Observed root is not correlated with an owning X11 window")
            })?;
            let action = action.to_owned();
            let center = (bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            let geometry = ActionGeometry {
                frame,
                image_width: record.image_width,
                image_height: record.image_height,
            };
            return off_worker(move || {
                physical(&action, &params, policy, owning_window, center, geometry)
            })
            .await;
        }
    };
    let owning_window = record
        .root
        .x11_window
        .ok_or_else(|| capability("Observed root is not correlated with an owning X11 window"))?;
    let frame = record.root.frame.ok_or_else(|| {
        ProtocolError::new(
            "Root has no coordinate geometry",
            ErrorCode::CoordinateUnavailableForRoot,
        )
    })?;
    let point = image_point_to_screen(&frame, record.image_width, record.image_height, x, y)?;
    let action = action.to_owned();
    let geometry = ActionGeometry {
        frame,
        image_width: record.image_width,
        image_height: record.image_height,
    };
    off_worker(move || physical(&action, &params, policy, owning_window, point, geometry)).await
}

#[derive(Debug, Clone)]
struct ActionGeometry {
    frame: Rect,
    image_width: u16,
    image_height: u16,
}

fn image_point_to_screen(
    frame: &Rect,
    image_width: u16,
    image_height: u16,
    x: f64,
    y: f64,
) -> Result<(i32, i32), ProtocolError> {
    if !x.is_finite()
        || !y.is_finite()
        || x < 0.0
        || y < 0.0
        || x >= f64::from(image_width)
        || y >= f64::from(image_height)
    {
        return Err(invalid("Coordinates are outside the owning look image"));
    }
    Ok((
        frame.x + (x * f64::from(frame.width) / f64::from(image_width.max(1))).round() as i32,
        frame.y + (y * f64::from(frame.height) / f64::from(image_height.max(1))).round() as i32,
    ))
}

fn scale_outline_rects(value: &mut Value, scale_x: f64, scale_y: f64) {
    match value {
        Value::Object(object) => {
            if let Some(Value::Object(rect)) = object.get_mut("rect") {
                for (key, scale) in [
                    ("x", scale_x),
                    ("w", scale_x),
                    ("y", scale_y),
                    ("h", scale_y),
                ] {
                    if let Some(number) = rect.get(key).and_then(Value::as_f64) {
                        rect.insert(key.to_owned(), json!(number * scale));
                    }
                }
            }
            for child in object.values_mut() {
                scale_outline_rects(child, scale_x, scale_y);
            }
        }
        Value::Array(items) => {
            for child in items {
                scale_outline_rects(child, scale_x, scale_y);
            }
        }
        _ => {}
    }
}

fn physical_act(
    action: &str,
    params: &Value,
    policy: PhysicalPolicy,
    owning_window: u32,
    point: (i32, i32),
    geometry: ActionGeometry,
) -> Result<Value, ProtocolError> {
    let input = Input::connect(policy, owning_window)?;
    deliver_physical(&input, action, params, owning_window, point, &geometry)
}

/// Drive one physical action through a scripted `RecordingSink` that shares the
/// helper-wide input state, so process tests exercise shutdown and release debt with no
/// display. Compiled only with the dev-only `testing` feature, never into a release.
#[cfg(feature = "testing")]
fn testing_act(args: &Value) -> Result<Value, ProtocolError> {
    use linux_bridge::testing::RecordingSink;
    let sink = RecordingSink::scripted(args.get("sink").unwrap_or(&Value::Null));
    let input = Input::with_state(sink, InputState::shared());
    input.settle()?;
    let action = required_str(args, "action", "testingAct requires action")?;
    let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
    let geometry = ActionGeometry {
        frame: Rect {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        },
        image_width: 100,
        image_height: 100,
    };
    let mut result = deliver_physical(&input, action, &params, 0, (1, 1), &geometry)?;
    result["evidence"]["held"] = json!(input.sink().held_inputs());
    result["evidence"]["events"] = json!(input.sink().events().len());
    Ok(result)
}

/// Drive one physical action through `input`. A stop after any posted event, or after
/// a post whose delivery is unknown, is `unknown` with `evidence.deliveredUnits`
/// (confirmed posts), `evidence.deliveryUncertain` when a post went unconfirmed,
/// `evidence.unconfirmedReleases` when cleanup could not confirm a release, and the
/// refusal code: input may have reached the desktop, so it must never become an error
/// a batch records as `didnt`.
fn deliver_physical<S: InputSink>(
    input: &Input<S>,
    action: &str,
    params: &Value,
    owning_window: u32,
    point: (i32, i32),
    geometry: &ActionGeometry,
) -> Result<Value, ProtocolError> {
    let result = drive_physical(input, action, params, point, geometry);
    let mut response = json!({
        "outcome":"unknown",
        "performed":{"grounding":"coordinates","delivery":"hid","mechanism":"xtest","deltaSource":"snapshot","windowId":owning_window},
        "evidence":{"mechanism":"xtest","windowId":owning_window}
    });
    match result {
        Ok(()) => Ok(response),
        Err(error) if input.delivered_units() == 0 && !input.delivery_uncertain() => Err(error),
        Err(error) => {
            response["evidence"]["deliveredUnits"] = json!(input.delivered_units());
            if input.delivery_uncertain() {
                response["evidence"]["deliveryUncertain"] = json!(true);
            }
            let unconfirmed = input.state().unconfirmed_releases();
            if !unconfirmed.is_empty() {
                response["evidence"]["unconfirmedReleases"] = json!(unconfirmed);
            }
            response["error"] = json!({"code":error.code.to_string(),"message":error.message});
            Ok(response)
        }
    }
}

fn drive_physical<S: InputSink>(
    input: &Input<S>,
    action: &str,
    params: &Value,
    point: (i32, i32),
    geometry: &ActionGeometry,
) -> Result<(), ProtocolError> {
    let (x, y) = point;
    let button = params
        .get("button")
        .and_then(Value::as_str)
        .unwrap_or("left");
    match action {
        "press" | "click" => input.click(
            x,
            y,
            button,
            params
                .get("clickCount")
                .and_then(Value::as_u64)
                .unwrap_or(1),
        )?,
        "moveMouse" => input.move_pointer(x, y)?,
        "scroll" => input.scroll(
            x,
            y,
            params.get("scrollX").and_then(Value::as_f64).unwrap_or(0.0),
            params.get("scrollY").and_then(Value::as_f64).unwrap_or(0.0),
        )?,
        "drag" => {
            let path = params
                .get("path")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("drag requires path"))?;
            let points = path
                .iter()
                .map(|p| {
                    image_point_to_screen(
                        &geometry.frame,
                        geometry.image_width,
                        geometry.image_height,
                        p.get("x")
                            .and_then(Value::as_f64)
                            .ok_or_else(|| invalid("drag point requires x"))?,
                        p.get("y")
                            .and_then(Value::as_f64)
                            .ok_or_else(|| invalid("drag point requires y"))?,
                    )
                })
                .collect::<Result<Vec<_>, ProtocolError>>()?;
            input.drag(&points, button)?;
        }
        "typeText" => input.type_text(params.get("text").and_then(Value::as_str).unwrap_or(""))?,
        "setText" => {
            input.click(x, y, button, 1)?;
            input.keypress(&["control", "a"])?;
            input.type_text(params.get("text").and_then(Value::as_str).unwrap_or(""))?;
        }
        "keypress" => {
            let keys = params
                .get("keys")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("keypress requires keys"))?
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            input.keypress(&keys)?;
        }
        other => {
            return Err(ProtocolError::new(
                format!("Unsupported Linux action '{other}'"),
                ErrorCode::UnsupportedCommand,
            ))
        }
    }
    Ok(())
}

/// Validate the entire batch before executing any step, then stop at the first failure
/// or, once `cancelled`, before the next step: steps already run keep their outcomes.
async fn act_batch_with<'args, F>(
    args: &'args Value,
    cancelled: impl Fn() -> bool,
    mut perform: impl FnMut(&'args Value) -> F,
) -> Result<Value, ProtocolError>
where
    F: Future<Output = Result<Value, ProtocolError>>,
{
    let actions = args
        .get("actions")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("actBatch requires actions"))?;
    if actions.is_empty() || actions.len() > 20 {
        return Err(invalid("actBatch requires 1...20 actions"));
    }
    let first_look = required_str(&actions[0], "lookId", "actBatch actions require lookId")?;
    if actions
        .iter()
        .any(|action| action.get("lookId").and_then(Value::as_str) != Some(first_look))
    {
        return Err(invalid("actBatch actions must belong to one look"));
    }
    let mut steps = Vec::new();
    let mut stopped_at = None;
    let mut timed_out = false;
    for (index, action) in actions.iter().enumerate() {
        if cancelled() {
            let error = shutting_down();
            steps.push(json!({"outcome":"didnt","error":{"code":error.code.to_string(),"message":error.message}}));
            stopped_at = Some(index);
            break;
        }
        match perform(action).await {
            Ok(step) => {
                // A step that reports an error stopped partway: nothing after it may run.
                let stopped = step.get("outcome").and_then(Value::as_str) == Some("didnt")
                    || step.get("error").is_some();
                steps.push(step);
                if stopped {
                    stopped_at = Some(index);
                    break;
                }
            }
            Err(error) => {
                timed_out = error.code == ErrorCode::Timeout;
                let outcome = if timed_out { "unknown" } else { "didnt" };
                steps.push(json!({"outcome":outcome,"error":{"code":error.code.to_string(),"message":error.message}}));
                stopped_at = Some(index);
                break;
            }
        }
    }
    let outcome = if timed_out {
        "unknown"
    } else {
        batch_outcome(&steps, stopped_at.is_some())
    };
    let mut response = json!({
        "outcome": outcome,
        "performed":{"transaction":true,"actionCount":steps.len(),"deltaSource":"snapshot"},
        "steps":steps
    });
    if let Some(index) = stopped_at {
        response["stoppedAt"] = json!(index);
    }
    Ok(response)
}

/// A stopped batch is `didnt` only when its first step checked that nothing happened.
/// Any step before the stop ran and may have delivered input, and a step that stopped
/// after posting is `unknown`, so those batches stay `unknown`; the refusal keeps its
/// own step.
fn batch_outcome(steps: &[Value], stopped: bool) -> &'static str {
    fn outcome(step: &Value) -> Option<&str> {
        step.get("outcome").and_then(Value::as_str)
    }
    if stopped && steps.len() == 1 && outcome(&steps[0]) == Some("didnt") {
        "didnt"
    } else if stopped || steps.iter().any(|step| outcome(step) == Some("unknown")) {
        "unknown"
    } else {
        "worked"
    }
}

/// Resolve and authorize a text read before requesting its content from accessibility.
async fn read_text_with(
    state: &Arc<Mutex<HelperState>>,
    args: &Value,
    read: impl AsyncFnOnce(&AccessibleRef, &AccessibleRef) -> Result<String, ProtocolError>,
) -> Result<Value, ProtocolError> {
    let look_id = required_str(args, "lookId", "atspiReadText requires lookId")?;
    let element_ref = required_str(args, "elementRef", "atspiReadText requires elementRef")?;
    let (root, node) = {
        let state = lock(state)?;
        (
            state.look(look_id)?.root.accessible,
            state.element(look_id, element_ref)?,
        )
    };
    if node.is_secure {
        return Err(ProtocolError::new(
            "Refers to a secure text field; refusing to read its value",
            ErrorCode::SecureTextUnreadable,
        ));
    }
    let text = if node.interfaces.contains(TEXT) {
        read(&root, &node.accessible).await?
    } else {
        String::new()
    };
    let characters = text.chars().collect::<Vec<_>>();
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(4096) as usize;
    let end = offset.saturating_add(limit).min(characters.len());
    let slice = if offset >= characters.len() {
        String::new()
    } else {
        characters[offset..end].iter().collect()
    };
    Ok(
        json!({"text":slice,"offset":offset,"limit":limit,"totalChars":characters.len(),"hasMore":end<characters.len()}),
    )
}

async fn wait_for(
    state: &Arc<Mutex<HelperState>>,
    args: &Value,
    connect: impl AsyncFnOnce() -> Result<AtspiClient, ProtocolError>,
) -> Result<Value, ProtocolError> {
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .map(|s| s.to_lowercase());
    let role = args
        .get("role")
        .and_then(Value::as_str)
        .map(|s| s.to_lowercase());
    let value = args
        .get("value")
        .and_then(Value::as_str)
        .map(|s| s.to_lowercase());
    if text.is_none() && role.is_none() && value.is_none() {
        return Err(invalid("atspiWaitFor requires text, role, or value"));
    }
    let (_, root) = resolve_root(state, args).await?;
    let scope_exact = args
        .get("scopeExact")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let scope = match (
        args.get("lookId").and_then(Value::as_str),
        args.get("scopeRef").and_then(Value::as_str),
    ) {
        (Some(look_id), Some(scope_ref)) => {
            let record = lock(state)?.look(look_id)?;
            if record.root.accessible != root.accessible {
                return Err(ProtocolError::new(
                    "Scope ref is outside the target root",
                    ErrorCode::StaleRef,
                ));
            }
            Some(lock(state)?.element(look_id, scope_ref)?)
        }
        (None, Some(_)) => return Err(invalid("scopeRef requires lookId")),
        _ => None,
    };
    let gone = args.get("gone").and_then(Value::as_bool).unwrap_or(false);
    let timeout = args
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(10_000)
        .clamp(100, 60_000);
    let deadline = Instant::now() + Duration::from_millis(timeout);
    let client = connect().await?;
    let mut node_count = 0;
    while Instant::now() < deadline {
        let Snapshot {
            nodes,
            incomplete,
            root_fields_incomplete,
        } = match &scope {
            Some(scope) => {
                client
                    .snapshot_within(&root.accessible, &scope.accessible, DEFAULT_MAX_NODES, 20)
                    .await?
            }
            None => client.snapshot(&root, DEFAULT_MAX_NODES, 20).await?,
        };
        node_count = nodes.len();
        let found = nodes
            .iter()
            .any(|node| matches_scoped_node(node, scope_exact, &text, &role, &value));
        if gone
            && !found
            && if scope_exact {
                root_fields_incomplete
            } else {
                incomplete
            }
        {
            return Err(ProtocolError::new(
                "Cannot confirm absence in an incomplete AT-SPI2 snapshot",
                ErrorCode::Timeout,
            ));
        }
        if found != gone {
            return Ok(
                json!({"found":true,"gone":if gone {Some(true)} else {None::<bool>},"nodeCount":node_count}),
            );
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Ok(json!({"found":false,"timedOut":true,"nodeCount":node_count}))
}

fn semantic_performed() -> Value {
    json!({"grounding":"description","delivery":"ax","deltaSource":"snapshot"})
}

fn matches_scoped_node(
    node: &NodeSnapshot,
    scope_exact: bool,
    text: &Option<String>,
    role: &Option<String>,
    value: &Option<String>,
) -> bool {
    (!scope_exact || node.depth == 0) && matches_node(node, text, role, value)
}

fn matches_node(
    node: &NodeSnapshot,
    text: &Option<String>,
    role: &Option<String>,
    value: &Option<String>,
) -> bool {
    text.as_ref()
        .map(|needle| node.searchable_text().contains(needle))
        .unwrap_or(true)
        && role
            .as_ref()
            .map(|expected| node.role.to_lowercase() == *expected)
            .unwrap_or(true)
        && value
            .as_ref()
            .map(|expected| node.value.trim().to_lowercase() == *expected)
            .unwrap_or(true)
}

fn required_str<'a>(value: &'a Value, key: &str, message: &str) -> Result<&'a str, ProtocolError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid(message))
}

fn lock(
    state: &Arc<Mutex<HelperState>>,
) -> Result<std::sync::MutexGuard<'_, HelperState>, ProtocolError> {
    state
        .lock()
        .map_err(|_| ProtocolError::new("helper state lock poisoned", ErrorCode::InternalError))
}

fn now_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(message, ErrorCode::InvalidRequest)
}

fn capability(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(message, ErrorCode::CapabilityDeferred)
}

#[cfg(test)]
#[path = "tests.rs"]
mod test_peer;

#[cfg(test)]
mod tests {
    use super::test_peer::{with_peer, StalledReply};
    use super::*;
    use linux_bridge::testing::RecordingSink;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::sync::watch;
    use zbus::{zvariant::OwnedObjectPath, Connection};

    /// A stdout that accepts no bytes until `opens` (never when `None`), then records them.
    struct ScriptedStdout {
        opens: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
        written: Arc<Mutex<Vec<u8>>>,
    }
    impl tokio::io::AsyncWrite for ScriptedStdout {
        fn poll_write(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            bytes: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            let Some(opens) = self.opens.as_mut() else {
                // Blocked for good, as a reader that stopped reading a full pipe.
                return std::task::Poll::Pending;
            };
            std::task::ready!(opens.as_mut().poll(cx));
            self.written.lock().unwrap().extend_from_slice(bytes);
            std::task::Poll::Ready(Ok(bytes.len()))
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    /// Run the exit wait on the paused clock, as `main` does after saturated shutdown: one
    /// request stuck for good, a `cancelled` reply queued for `ninth`, and a stdout that
    /// opens `opens` after shutdown began. Returns the outcome, the virtual time the wait
    /// took, and the reply ids written by then.
    async fn saturated_exit(opens: Option<Duration>) -> (Drained, Duration, Vec<String>) {
        let written = Arc::new(Mutex::new(Vec::new()));
        let stdout = ScriptedStdout {
            opens: opens.map(|after| Box::pin(tokio::time::sleep(after))),
            written: Arc::clone(&written),
        };
        let (queue, responses) = mpsc::unbounded_channel();
        let output = Replies(queue);
        let writer = tokio::spawn(write_replies(stdout, responses));
        let mut requests = tokio::task::JoinSet::new();
        let held = output.clone();
        requests.spawn(async move {
            // Stuck on an X11 reply that never comes, still owning a reply sender.
            let _output = held;
            std::future::pending::<()>().await;
        });
        output.send(Response::err("ninth", shutting_down()));
        let started = tokio::time::Instant::now();
        let drained = drain(&mut requests, output, writer).await;
        let elapsed = started.elapsed();
        let ids = String::from_utf8(written.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| {
                let reply: Value = serde_json::from_str(line).unwrap();
                assert_eq!(reply["error"]["code"], "cancelled", "{reply}");
                reply["id"].as_str().unwrap().to_owned()
            })
            .collect();
        (drained, elapsed, ids)
    }

    /// The whole exit past a stuck request, flush included, within the client's grace.
    const SATURATED_EXIT: Duration = EXIT_JOIN_LIMIT.saturating_add(EXIT_FLUSH_LIMIT);

    #[tokio::test(start_paused = true)]
    async fn saturated_exit_flushes_queued_replies_inside_the_kill_grace() {
        // Stdout opens just before the flush limit: the queued reply is written once.
        let just_in_time = SATURATED_EXIT - Duration::from_millis(1);
        let (drained, elapsed, ids) = saturated_exit(Some(just_in_time)).await;
        assert_eq!(drained, Drained::Stuck);
        assert_eq!(ids, ["ninth"]);
        assert_eq!(elapsed, just_in_time);
        assert!(elapsed < KILL_GRACE, "{elapsed:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn saturated_exit_leaves_a_blocked_stdout_at_its_deadline() {
        // A stdout opening just past the limit, or never, is not waited for: best effort.
        for opens in [Some(SATURATED_EXIT + Duration::from_millis(1)), None] {
            let (drained, elapsed, ids) = saturated_exit(opens).await;
            assert_eq!(drained, Drained::Stuck, "{opens:?}");
            assert!(ids.is_empty(), "{opens:?}: {ids:?}");
            assert_eq!(elapsed, SATURATED_EXIT, "{opens:?}");
            assert!(elapsed < KILL_GRACE, "{opens:?}: {elapsed:?}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn exit_waits_for_every_reply_once_all_requests_finish() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let stdout = ScriptedStdout {
            // Past both limits: with no request stuck, the writer is waited out.
            opens: Some(Box::pin(tokio::time::sleep(KILL_GRACE))),
            written: Arc::clone(&written),
        };
        let (queue, responses) = mpsc::unbounded_channel();
        let output = Replies(queue);
        let writer = tokio::spawn(write_replies(stdout, responses));
        let mut requests = tokio::task::JoinSet::new();
        let replying = output.clone();
        requests.spawn(async move { replying.send(Response::ok("done", json!({}))) });
        assert_eq!(drain(&mut requests, output, writer).await, Drained::All);
        let written = String::from_utf8(written.lock().unwrap().clone()).unwrap();
        assert_eq!(written.lines().count(), 1, "{written}");
        assert!(written.contains("\"id\":\"done\""), "{written}");
    }

    #[tokio::test(start_paused = true)]
    async fn exit_wait_ends_when_the_writer_already_stopped() {
        let (queue, responses) = mpsc::unbounded_channel();
        drop(responses);
        let mut requests = tokio::task::JoinSet::new();
        requests.spawn(std::future::pending::<()>());
        let writer = tokio::spawn(async {});
        let started = tokio::time::Instant::now();
        let drained = drain(&mut requests, Replies(queue), writer).await;
        assert_eq!(drained, Drained::Stuck);
        // No flush wait for a writer that is gone.
        assert_eq!(started.elapsed(), EXIT_JOIN_LIMIT);
    }

    fn node() -> NodeSnapshot {
        NodeSnapshot {
            reference: "linux:look_1:@e1".into(),
            accessible: AccessibleRef {
                destination: ":1.1".into(),
                path: "/node".into(),
            },
            parent: None,
            name: "Save document".into(),
            role: "push button".into(),
            description: "Writes changes".into(),
            value: String::new(),
            interfaces: HashSet::new(),
            bounds: None,
            is_secure: false,
            depth: 0,
            unread: false,
        }
    }

    struct SnapshotFixture {
        path: &'static str,
        limits: (usize, usize),
        nodes: Vec<NodeSnapshot>,
    }

    impl SnapshotSource for SnapshotFixture {
        async fn snapshot_within(
            &self,
            root: &AccessibleRef,
            scope: Option<&AccessibleRef>,
            max_nodes: usize,
            max_depth: usize,
        ) -> Result<Vec<NodeSnapshot>, ProtocolError> {
            assert_eq!(scope.unwrap_or(root).path, self.path);
            assert_eq!((max_nodes, max_depth), self.limits);
            Ok(self.nodes.clone())
        }
    }

    fn observed_root() -> RootSnapshot {
        RootSnapshot {
            accessible: AccessibleRef {
                destination: ":1.1".into(),
                path: "/window".into(),
            },
            pid: 42,
            name: "Editor".into(),
            app_name: "Editor".into(),
            executable: None,
            wm_class: None,
            class_candidates: Vec::new(),
            role: "Dialog".into(),
            frame: Some(Rect {
                x: 100,
                y: 50,
                width: 400,
                height: 200,
            }),
            x11_window: Some(71),
            is_focused: true,
            is_minimized: false,
            z_order: None,
        }
    }

    #[tokio::test]
    async fn look_capture_and_scope_share_the_stored_image_space() {
        let state = Arc::new(Mutex::new(HelperState::default()));
        let mut other = observed_root();
        other.pid = 43;
        other.accessible.path = "/other".into();
        let roots = lock(&state)
            .unwrap()
            .replace_roots(vec![other, observed_root()]);
        let mut button = node();
        button.bounds = Some(Rect {
            x: 120,
            y: 70,
            width: 40,
            height: 20,
        });
        let whole = look_with(
            &state,
            &json!({"pid":42,"maxNodes":9000,"maxDepth":0,"maxDimension":100}),
            async || {
                Ok(SnapshotFixture {
                    path: "/window",
                    limits: (4096, 1),
                    nodes: vec![button.clone()],
                })
            },
            |window, max_dimension| {
                assert_eq!((window, max_dimension), (71, Some(100)));
                Ok(x11::Capture {
                    png_base64: "fixture".into(),
                    width: 100,
                    height: 50,
                    source: "get_image",
                    warnings: vec!["obscured".into()],
                })
            },
        )
        .await
        .unwrap();
        assert_eq!(whole["window"]["rootRef"], roots[1].0);
        assert_eq!(whole["window"]["isModal"], true);
        assert_eq!(
            whole["outline"]["rect"],
            json!({"x":5.0,"y":5.0,"w":10.0,"h":5.0})
        );
        assert_eq!(
            whole["image"],
            json!({"jpegBase64":"fixture","mimeType":"image/png","width":100,"height":50,"metadata":{"source":"get_image","warnings":["obscured"]}})
        );
        let scope = |root: &str| {
            json!({
                "rootRef": root, "scopeRef": whole["outline"]["ref"],
                "baseLookId": whole["lookId"], "includeImage": false, "readText": "never"
            })
        };
        let scoped = look_with(
            &state,
            &scope(&roots[1].0),
            async || {
                Ok(SnapshotFixture {
                    path: "/node",
                    limits: (512, 20),
                    nodes: vec![button],
                })
            },
            |_, _| panic!("no-image look requested capture"),
        )
        .await
        .unwrap();
        assert!(scoped.get("image").is_none());
        assert_eq!(
            scoped["readText"],
            json!({"requested":"never","executed":false})
        );
        assert_eq!(scoped["outline"]["rect"], whole["outline"]["rect"]);
        let look_id = scoped["lookId"].as_str().unwrap();
        let record = lock(&state).unwrap().look(look_id).unwrap();
        assert_eq!((record.image_width, record.image_height), (100, 50));
        let error = look_with(
            &state,
            &scope(&roots[0].0),
            async || {
                Ok(SnapshotFixture {
                    path: "/must-not-snapshot",
                    limits: (0, 0),
                    nodes: vec![],
                })
            },
            |_, _| panic!("foreign scope requested capture"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::StaleRef);
        let error = look_with(
            &state,
            &json!({"readText":"invalid"}),
            async || Err::<SnapshotFixture, _>(capability("fixture connection unavailable")),
            |_, _| panic!("invalid look requested capture"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidRequest);
    }

    thread_local! {
        /// Set on a test's own thread, which runs its request futures: blocking X11 work
        /// that finds it set ran on the request's thread instead of the blocking pool.
        static ON_REQUEST_THREAD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    fn assert_off_request_thread(what: &str) {
        assert!(
            !ON_REQUEST_THREAD.with(std::cell::Cell::get),
            "{what} ran on the request thread"
        );
    }

    #[tokio::test]
    async fn blocking_x11_work_runs_off_the_request_thread() {
        ON_REQUEST_THREAD.with(|flag| flag.set(true));
        let state = Arc::new(Mutex::new(HelperState::default()));
        lock(&state).unwrap().replace_roots(vec![observed_root()]);
        let mut button = node();
        button.bounds = Some(Rect {
            x: 120,
            y: 70,
            width: 40,
            height: 20,
        });
        let look = look_with(
            &state,
            &json!({"pid":42,"maxNodes":9000,"maxDepth":0}),
            async || {
                Ok(SnapshotFixture {
                    path: "/window",
                    limits: (4096, 1),
                    nodes: vec![button],
                })
            },
            |_, _| {
                assert_off_request_thread("capture");
                Ok(x11::Capture {
                    png_base64: "fixture".into(),
                    width: 100,
                    height: 50,
                    source: "get_image",
                    warnings: Vec::new(),
                })
            },
        )
        .await
        .unwrap();
        let look_id = look["lookId"].as_str().unwrap().to_owned();
        let element = look["outline"]["ref"].clone();
        with_peer(Ok, async |connection| {
            // A coordinate target, and an element whose semantic press finds no Action
            // interface on the peer, so it falls back to the element centre.
            for target in [json!({"x":1,"y":1}), json!({"ref": element})] {
                let args = json!({"lookId":look_id,"action":"press","target":target,"policy":"foreground"});
                let reply = act(
                    &state,
                    &args,
                    async || Ok(AtspiClient::from_connection(connection.clone(), Duration::from_secs(2))),
                    |_, _, _, _, _, _| {
                        assert_off_request_thread("physical delivery");
                        Ok(json!({"outcome":"worked"}))
                    },
                )
                .await
                .unwrap();
                assert_eq!(reply["outcome"], "worked", "{args}");
            }
        })
        .await;
    }

    #[tokio::test]
    async fn focus_and_the_x11_probe_run_off_the_request_thread() {
        ON_REQUEST_THREAD.with(|flag| flag.set(true));
        let state = Arc::new(Mutex::new(HelperState::default()));
        let (reference, _) = lock(&state).unwrap().replace_roots(vec![observed_root()])[0].clone();
        let focused = focus_window_with(
            &state,
            &json!({"rootRef": reference, "policy": "foreground"}),
            |window, _| {
                assert_off_request_thread("focus");
                Ok(json!({"focused": window}))
            },
        )
        .await
        .unwrap();
        assert_eq!(focused, json!({"focused": 71}));
        let report = diagnostics_with(|| {
            assert_off_request_thread("the X11 probe");
            true
        })
        .await;
        assert_eq!(report["x11"], true);
    }

    fn panicking_work() -> Result<(), ProtocolError> {
        panic!("x11 work panicked")
    }

    #[tokio::test]
    async fn joined_blocking_work_resumes_panics_and_reports_cancellation() {
        // A task Tokio cancelled is an internal error, not a second panic.
        let task = tokio::spawn(std::future::pending::<Result<(), ProtocolError>>());
        task.abort();
        let cancelled = task.await;
        assert!(cancelled
            .as_ref()
            .is_err_and(tokio::task::JoinError::is_cancelled));
        let error = joined(cancelled).unwrap_err();
        assert_eq!(error.code, ErrorCode::InternalError);
        assert!(
            error
                .message
                .starts_with("Blocking X11 work did not finish"),
            "{}",
            error.message
        );
        // A panic resumes with its own payload, as it would have on the request worker.
        let panicked = tokio::spawn(async { panicking_work() }).await;
        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| joined(panicked)))
            .unwrap_err();
        assert_eq!(payload.downcast_ref::<&str>(), Some(&"x11 work panicked"));
        // Finished work is its own result.
        assert_eq!(joined(Ok(Ok(7))).unwrap(), 7);
    }

    #[tokio::test]
    async fn read_text_pages_unicode_and_refuses_secure_content() {
        let state = Arc::new(Mutex::new(HelperState::default()));
        let mut editor = node();
        editor.interfaces.insert(TEXT.into());
        let mut password = editor.clone();
        password.accessible.path = "/password".into();
        password.is_secure = true;
        let (look_id, nodes) =
            lock(&state)
                .unwrap()
                .insert_look(observed_root(), vec![editor, password], None);
        let args = |index: usize, offset| json!({"lookId":look_id,"elementRef":nodes[index].reference,"offset":offset,"limit":2});
        let read = async |_root: &AccessibleRef, target: &AccessibleRef| {
            assert_eq!(target.path, "/node");
            Ok("A雪😊z".into())
        };
        assert_eq!(
            read_text_with(&state, &args(0, 1), read).await.unwrap(),
            json!({"text":"雪😊","offset":1,"limit":2,"totalChars":4,"hasMore":true})
        );
        assert_eq!(
            read_text_with(&state, &args(0, 9), read).await.unwrap(),
            json!({"text":"","offset":9,"limit":2,"totalChars":4,"hasMore":false})
        );
        assert_eq!(
            read_text_with(&state, &args(1, 0), read)
                .await
                .unwrap_err()
                .code,
            ErrorCode::SecureTextUnreadable
        );
    }

    #[tokio::test]
    async fn batches_validate_before_dispatch_and_stop_after_failure() {
        for invalid_batch in [
            json!({}),
            json!({"actions":[]}),
            json!({"actions":[{}]}),
            json!({"actions":[{"lookId":"one"},{"lookId":"two"}]}),
            json!({"actions":vec![json!({"lookId":"one"}); 21]}),
        ] {
            let error = act_batch_with(
                &invalid_batch,
                || false,
                |_| async { panic!("invalid batch performed an action") },
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidRequest);
        }
        let batch = json!({"actions":[{"lookId":"one","value":0},{"lookId":"one","value":1},{"lookId":"one","value":2}]});
        for failure in [false, true] {
            let mut seen = Vec::new();
            let result = act_batch_with(
                &batch,
                || false,
                |action| {
                    let value = action["value"].as_u64().unwrap();
                    seen.push(value);
                    std::future::ready(match value {
                        0 => Ok(json!({"outcome":"unknown"})),
                        1 if failure => Err(invalid("step failed")),
                        1 => Ok(json!({"outcome":"didnt"})),
                        _ => panic!("ran an action after failure"),
                    })
                },
            )
            .await
            .unwrap();
            assert_eq!(seen, [0, 1]);
            // Step 0 ran and may have delivered input: the refusal stays on step 1.
            assert_eq!(result["outcome"], "unknown");
            assert_eq!(result["stoppedAt"], 1);
            assert_eq!(result["performed"]["actionCount"], 2);
            assert_eq!(result["steps"][0]["outcome"], "unknown");
            assert_eq!(result["steps"][1]["outcome"], "didnt");
            if failure {
                assert_eq!(
                    result["steps"][1]["error"],
                    json!({"code":"invalid_request","message":"step failed"})
                );
            }
        }
        let result = act_batch_with(
            &batch,
            || false,
            |action| async move {
                Ok(json!({"outcome":if action["value"] == 1 {"unknown"} else {"worked"}}))
            },
        )
        .await
        .unwrap();
        assert_eq!(result["outcome"], "unknown");
        assert!(result.get("stoppedAt").is_none());
        assert_eq!(result["performed"]["actionCount"], 3);

        // Shutdown after a semantic step: it keeps its outcome and nothing later starts.
        let ran = std::cell::Cell::new(0);
        let result = act_batch_with(
            &batch,
            || ran.get() >= 1,
            |_| {
                ran.set(ran.get() + 1);
                std::future::ready(Ok(
                    json!({"outcome":"worked","performed":{"delivery":"ax"}}),
                ))
            },
        )
        .await
        .unwrap();
        assert_eq!(ran.get(), 1);
        assert_eq!(result["outcome"], "unknown");
        assert_eq!(result["stoppedAt"], 1);
        assert_eq!(result["steps"][0]["outcome"], "worked");
        assert_eq!(result["steps"][1]["outcome"], "didnt");
        assert_eq!(result["steps"][1]["error"]["code"], "cancelled");
    }

    #[test]
    fn scoped_matching_includes_descendants_unless_exact() {
        let mut descendant = node();
        descendant.depth = 1;
        assert!(matches_scoped_node(
            &descendant,
            false,
            &Some("save".into()),
            &None,
            &None
        ));
        assert!(!matches_scoped_node(
            &descendant,
            true,
            &Some("save".into()),
            &None,
            &None
        ));
    }

    #[tokio::test]
    async fn read_text_without_text_interface_returns_empty_text() {
        let root = RootSnapshot {
            accessible: AccessibleRef {
                destination: ":1.1".into(),
                path: "/window".into(),
            },
            pid: 1,
            name: "Calculator".into(),
            app_name: "Calculator".into(),
            executable: None,
            wm_class: None,
            class_candidates: Vec::new(),
            role: "frame".into(),
            frame: None,
            x11_window: None,
            is_focused: false,
            is_minimized: false,
            z_order: None,
        };
        let mut display = node();
        display.interfaces.insert("org.a11y.atspi.Action".into());
        let state = Arc::new(Mutex::new(HelperState::default()));
        let (look_id, nodes) = lock(&state).unwrap().insert_look(root, vec![display], None);
        let result = read_text_with(
            &state,
            &json!({"lookId": look_id, "elementRef": nodes[0].reference}),
            async |_, _| panic!("non-text node requested text"),
        )
        .await
        .unwrap();
        assert_eq!(result["text"], "");
        assert_eq!(result["totalChars"], 0);
        assert_eq!(result["hasMore"], false);
    }

    async fn peer_request(
        state: &Arc<Mutex<HelperState>>,
        connection: &Connection,
        cmd: &str,
        args: Value,
    ) -> Response {
        handle_request_with(
            state,
            &Request {
                protocol_version: PROTOCOL_VERSION,
                id: "peer".into(),
                cmd: cmd.into(),
                args,
            },
            &InputState::default(),
            async || {
                Ok(AtspiClient::from_connection(
                    connection.clone(),
                    Duration::from_millis(250),
                ))
            },
            |_, _, _, _, _, _| panic!("attempted physical fallback"),
        )
        .await
    }

    /// Fixture role name that makes `GetRoleName` fail with a non-timeout error.
    const FAILING_ROLE_NAME: &str = "<GetRoleName fails>";
    /// Fixture `Parent` that fails with a fast non-timeout error.
    const FAILING_PARENT: (&str, &str) = ("<Parent fails>", "/");
    /// Fixture `Parent` that never replies.
    const STALLED_PARENT: (&str, &str) = ("<Parent stalls>", "/");

    struct PeerNode {
        name: &'static str,
        role: watch::Receiver<Option<u32>>,
        stalled_role: Option<StalledReply>,
        role_name: &'static str,
        stalled_children: Option<StalledReply>,
        child: Option<&'static str>,
        /// The live `Parent` (bus name, path); `None` does not implement the property, and
        /// `FAILING_PARENT` and `STALLED_PARENT` fail or stall the read.
        parent: Option<(&'static str, &'static str)>,
        text: bool,
    }

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl PeerNode {
        #[zbus(property)]
        fn name(&self) -> &str {
            self.name
        }

        #[zbus(property)]
        fn description(&self) -> &str {
            self.name
        }

        fn get_role_name(&self) -> zbus::fdo::Result<&str> {
            if self.role_name == FAILING_ROLE_NAME {
                return Err(zbus::fdo::Error::Failed("role name unavailable".into()));
            }
            Ok(self.role_name)
        }

        async fn get_role(&self) -> zbus::fdo::Result<u32> {
            let role = *self.role.borrow();
            match role {
                Some(id) => Ok(id),
                None => match &self.stalled_role {
                    Some(stall) => stall.wait().await,
                    None => Err(zbus::fdo::Error::Failed("role unavailable".into())),
                },
            }
        }

        async fn get_children(&self) -> Vec<(&str, OwnedObjectPath)> {
            if let Some(stall) = &self.stalled_children {
                return stall.wait().await;
            }
            self.child
                .iter()
                .map(|path| (":1.1", OwnedObjectPath::try_from(*path).unwrap()))
                .collect()
        }

        fn get_interfaces(&self) -> Vec<&str> {
            if self.text {
                vec![TEXT]
            } else {
                vec![]
            }
        }

        #[zbus(property)]
        async fn parent(&self) -> zbus::fdo::Result<(&str, OwnedObjectPath)> {
            match self.parent {
                None => Err(zbus::fdo::Error::UnknownProperty("no Parent".into())),
                Some(FAILING_PARENT) => Err(zbus::fdo::Error::Failed("parent unavailable".into())),
                Some(STALLED_PARENT) => std::future::pending().await,
                Some((destination, path)) => {
                    Ok((destination, OwnedObjectPath::try_from(path).unwrap()))
                }
            }
        }
    }

    struct PeerText {
        reads: Arc<AtomicUsize>,
        transition: Option<(watch::Sender<Option<u32>>, Option<u32>)>,
    }

    impl PeerText {
        fn new(reads: Arc<AtomicUsize>) -> Self {
            Self {
                reads,
                transition: None,
            }
        }
    }

    #[zbus::interface(name = "org.a11y.atspi.Text")]
    impl PeerText {
        fn get_text(&self, _start: i32, _end: i32) -> &str {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if let Some((role, next)) = &self.transition {
                role.send(*next).unwrap();
            }
            "private fixture text"
        }
    }

    fn peer_root_state() -> (Arc<Mutex<HelperState>>, String) {
        let state = Arc::new(Mutex::new(HelperState::default()));
        let root_ref = lock(&state).unwrap().replace_roots(vec![observed_root()])[0]
            .0
            .clone();
        (state, root_ref)
    }

    #[tokio::test]
    async fn unknown_role_never_reads_or_exposes_text() {
        let (stall, mut requests) = StalledReply::new();
        let reads = Arc::new(AtomicUsize::new(0));
        let (state, root_ref) = peer_root_state();
        with_peer(
            |peer| {
                peer.serve_at(
                    "/window",
                    PeerNode {
                        name: "Password",
                        role: watch::channel(None).1,
                        role_name: "password text",
                        stalled_role: Some(stall),
                        stalled_children: None,
                        child: None,
                        parent: None,
                        text: true,
                    },
                )?
                .serve_at("/window", PeerText::new(Arc::clone(&reads)))
            },
            async |connection| {
                let look = peer_request(
                    &state,
                    &connection,
                    "look",
                    json!({"rootRef":root_ref,"includeImage":false}),
                )
                .await
                .result
                .unwrap();
                assert_eq!(requests.try_recv(), Ok(()));
                assert_eq!(look["outline"]["title"], "[protected]");
                assert_eq!(look["outline"]["value"], "");
                assert_eq!(reads.load(Ordering::SeqCst), 0);
                let reply = peer_request(
                    &state,
                    &connection,
                    "atspiReadText",
                    json!({"lookId":look["lookId"],"elementRef":look["outline"]["ref"]}),
                )
                .await;
                assert_eq!(reply.error.unwrap().code, ErrorCode::SecureTextUnreadable);
                assert_eq!(reads.load(Ordering::SeqCst), 0);
            },
        )
        .await;
    }

    #[tokio::test]
    async fn literal_unknown_role_never_reads_or_exposes_text() {
        let reads = Arc::new(AtomicUsize::new(0));
        let (state, root_ref) = peer_root_state();
        with_peer(
            |peer| {
                peer.serve_at(
                    "/window",
                    PeerNode {
                        name: "Fixture",
                        role: watch::channel(Some(67)).1,
                        role_name: "unknown",
                        stalled_role: None,
                        stalled_children: None,
                        child: None,
                        parent: None,
                        text: true,
                    },
                )?
                .serve_at("/window", PeerText::new(Arc::clone(&reads)))
            },
            async |connection| {
                let look = peer_request(
                    &state,
                    &connection,
                    "look",
                    json!({"rootRef":root_ref,"includeImage":false}),
                )
                .await
                .result
                .unwrap();
                assert_eq!(look["outline"]["value"], "");
                let gone = peer_request(
                    &state,
                    &connection,
                    "atspiWaitFor",
                    json!({"rootRef":root_ref,"text":"private fixture text","gone":true}),
                )
                .await;
                assert_eq!(gone.error.unwrap().code, ErrorCode::Timeout);
                let reply = peer_request(
                    &state,
                    &connection,
                    "atspiReadText",
                    json!({"lookId":look["lookId"],"elementRef":look["outline"]["ref"]}),
                )
                .await;
                assert_eq!(reply.error.unwrap().code, ErrorCode::SecureTextUnreadable);
                assert_eq!(reads.load(Ordering::SeqCst), 0);
            },
        )
        .await;
    }

    /// A readable numeric role does not authorize text when its role name contradicts it or
    /// cannot be read (#1189).
    #[tokio::test]
    async fn contradicting_or_unread_role_name_never_reads_text() {
        for role_name in [
            "unknown",
            " Unknown ",
            "PASSWORD TEXT",
            "invalid",
            "",
            FAILING_ROLE_NAME,
        ] {
            let reads = Arc::new(AtomicUsize::new(0));
            let (state, root_ref) = peer_root_state();
            with_peer(
                |peer| {
                    peer.serve_at(
                        "/window",
                        PeerNode {
                            name: "Fixture",
                            role: watch::channel(Some(61)).1,
                            role_name,
                            stalled_role: None,
                            stalled_children: None,
                            child: None,
                            parent: None,
                            text: true,
                        },
                    )?
                    .serve_at("/window", PeerText::new(Arc::clone(&reads)))
                },
                async |connection| {
                    let look = peer_request(
                        &state,
                        &connection,
                        "look",
                        json!({"rootRef":root_ref,"includeImage":false}),
                    )
                    .await
                    .result
                    .unwrap();
                    assert_eq!(look["outline"]["value"], "", "{role_name:?}");
                    assert_eq!(look["outline"]["truncated"], true, "{role_name:?}");
                    let blank = role_name.trim().is_empty() || role_name == FAILING_ROLE_NAME;
                    let title = if blank { "Fixture" } else { "[protected]" };
                    assert_eq!(look["outline"]["title"], title, "{role_name:?}");
                    let reply = peer_request(
                        &state,
                        &connection,
                        "atspiReadText",
                        json!({"lookId":look["lookId"],"elementRef":look["outline"]["ref"]}),
                    )
                    .await;
                    assert_eq!(
                        reply.error.map(|error| error.code),
                        Some(ErrorCode::SecureTextUnreadable),
                        "{role_name:?}"
                    );
                    assert_eq!(reads.load(Ordering::SeqCst), 0, "{role_name:?}");
                },
            )
            .await;
        }
    }

    #[tokio::test]
    async fn protected_metadata_never_reaches_the_cached_outline() {
        const SECRET: &str = "private fixture label";
        let reads = Arc::new(AtomicUsize::new(0));
        let (role, current_role) = watch::channel(Some(61));
        let (state, root_ref) = peer_root_state();
        with_peer(
            |peer| {
                peer.serve_at(
                    "/window",
                    PeerNode {
                        name: SECRET,
                        role: current_role,
                        role_name: "fixture role",
                        stalled_role: None,
                        stalled_children: None,
                        child: None,
                        parent: None,
                        text: true,
                    },
                )?
                .serve_at("/window", PeerText::new(Arc::clone(&reads)))
            },
            async |connection| {
                let look_args = json!({"rootRef":root_ref,"includeImage":false});
                let observed = peer_request(&state, &connection, "look", look_args.clone())
                    .await
                    .result
                    .unwrap();
                assert_eq!(observed["outline"]["title"], SECRET);
                assert_eq!(observed["outline"]["description"], SECRET);
                let permitted_reads = reads.load(Ordering::SeqCst);
                for id in [40, 67] {
                    role.send(Some(id)).unwrap();
                    let fresh = peer_request(&state, &connection, "look", look_args.clone())
                        .await
                        .result
                        .unwrap();
                    assert!(!fresh.to_string().contains(SECRET), "role ID {id}");
                    let node = lock(&state)
                        .unwrap()
                        .element(
                            fresh["lookId"].as_str().unwrap(),
                            fresh["outline"]["ref"].as_str().unwrap(),
                        )
                        .unwrap();
                    assert_eq!(node.name, "[protected]");
                    assert!(node.description.is_empty());
                    assert!(!node.searchable_text().contains(SECRET));
                    // A protected scope refuses rather than returning a redacted node (#1233).
                    let scoped = peer_request(
                        &state,
                        &connection,
                        "look",
                        json!({
                            "rootRef":root_ref,"includeImage":false,
                            "baseLookId":fresh["lookId"],"scopeRef":fresh["outline"]["ref"],
                        }),
                    )
                    .await;
                    assert!(!format!("{scoped:?}").contains(SECRET), "role ID {id}");
                    assert_eq!(
                        scoped.error.unwrap().code,
                        ErrorCode::SecureTextUnreadable,
                        "role ID {id}"
                    );
                    assert_eq!(reads.load(Ordering::SeqCst), permitted_reads);
                }
            },
        )
        .await;
    }

    #[tokio::test]
    async fn wait_for_never_matches_protected_metadata() {
        const SECRET: &str = "private fixture label";
        let (role, current_role) = watch::channel(Some(61));
        let (state, root_ref) = peer_root_state();
        with_peer(
            |peer| {
                peer.serve_at(
                    "/window",
                    PeerNode {
                        name: SECRET,
                        role: current_role,
                        role_name: "fixture role",
                        stalled_role: None,
                        stalled_children: None,
                        child: None,
                        parent: None,
                        text: false,
                    },
                )
            },
            async |connection| {
                let look = peer_request(
                    &state,
                    &connection,
                    "look",
                    json!({"rootRef":root_ref,"includeImage":false}),
                )
                .await
                .result
                .unwrap();
                let wait = async |scoped: bool| {
                    let mut args = json!({"rootRef":root_ref,"text":SECRET,"timeoutMs":100});
                    if scoped {
                        args["lookId"] = look["lookId"].clone();
                        args["scopeRef"] = look["outline"]["ref"].clone();
                    }
                    peer_request(&state, &connection, "atspiWaitFor", args).await
                };
                for scoped in [false, true] {
                    assert_eq!(
                        wait(scoped).await.result.unwrap()["found"],
                        true,
                        "readable, scoped {scoped}"
                    );
                }
                for id in [40, 67] {
                    role.send(Some(id)).unwrap();
                    let reply = wait(false).await.result.unwrap();
                    assert_eq!(reply["found"], false, "role ID {id}");
                    assert_eq!(reply["timedOut"], true, "role ID {id}");
                    // A protected scope refuses rather than searching a redacted node (#1233).
                    let scoped = wait(true).await;
                    assert!(!format!("{scoped:?}").contains(SECRET), "role ID {id}");
                    assert_eq!(
                        scoped.error.unwrap().code,
                        ErrorCode::SecureTextUnreadable,
                        "role ID {id}"
                    );
                }
            },
        )
        .await;
    }

    #[tokio::test]
    async fn rejects_unclassified_atspi_roles() {
        let reads = Arc::new(AtomicUsize::new(0));
        let (role, current_role) = watch::channel(Some(61));
        let (state, root_ref) = peer_root_state();
        with_peer(
            |peer| {
                peer.serve_at(
                    "/window",
                    PeerNode {
                        name: "Fixture",
                        role: current_role,
                        role_name: "ordinary text",
                        stalled_role: None,
                        stalled_children: None,
                        child: None,
                        parent: None,
                        text: true,
                    },
                )?
                .serve_at("/window", PeerText::new(Arc::clone(&reads)))
            },
            async |connection| {
                let look_args = json!({"rootRef":root_ref,"includeImage":false});
                let old = peer_request(&state, &connection, "look", look_args.clone())
                    .await
                    .result
                    .unwrap();
                assert_eq!(old["outline"]["value"], "private fixture text");
                let permitted_reads = reads.load(Ordering::SeqCst);
                for id in [0, 67, 70, 131, u32::MAX, 40] {
                    role.send(Some(id)).unwrap();
                    let look = peer_request(&state, &connection, "look", look_args.clone())
                        .await
                        .result
                        .unwrap();
                    assert_eq!(look["outline"]["value"], "", "role ID {id}");
                    let reply = peer_request(
                        &state,
                        &connection,
                        "atspiReadText",
                        json!({"lookId":old["lookId"],"elementRef":old["outline"]["ref"]}),
                    )
                    .await;
                    assert_eq!(
                        reply.error.unwrap().code,
                        ErrorCode::SecureTextUnreadable,
                        "role ID {id}"
                    );
                    assert_eq!(
                        reads.load(Ordering::SeqCst),
                        permitted_reads,
                        "role ID {id}"
                    );
                }
            },
        )
        .await;
    }

    #[tokio::test]
    async fn old_look_cannot_authorize_live_text() {
        let reads = Arc::new(AtomicUsize::new(0));
        let (role, current_role) = watch::channel(Some(61));
        let (stall, mut requests) = StalledReply::new();
        let (state, root_ref) = peer_root_state();
        with_peer(
            |peer| {
                peer.serve_at(
                    "/window",
                    PeerNode {
                        name: "Fixture",
                        role: current_role,
                        role_name: "text",
                        stalled_role: Some(stall),
                        stalled_children: None,
                        child: None,
                        parent: None,
                        text: true,
                    },
                )?
                .serve_at("/window", PeerText::new(Arc::clone(&reads)))
            },
            async |connection| {
                let look = async || {
                    peer_request(
                        &state,
                        &connection,
                        "look",
                        json!({"rootRef":root_ref,"includeImage":false}),
                    )
                    .await
                    .result
                    .unwrap()
                };
                let read = async |look: &Value| {
                    peer_request(
                        &state,
                        &connection,
                        "atspiReadText",
                        json!({"lookId":look["lookId"],"elementRef":look["outline"]["ref"]}),
                    )
                    .await
                };
                let old_look = look().await;
                assert_eq!(
                    read(&old_look).await.result.unwrap()["text"],
                    "private fixture text"
                );
                let permitted_reads = reads.load(Ordering::SeqCst);

                role.send(None).unwrap();
                assert_eq!(
                    read(&old_look).await.error.unwrap().code,
                    ErrorCode::SecureTextUnreadable
                );
                assert_eq!(requests.try_recv(), Ok(()));
                assert_eq!(reads.load(Ordering::SeqCst), permitted_reads);
                let new_look = look().await;
                assert_ne!(old_look["lookId"], new_look["lookId"]);
                assert_eq!(new_look["outline"]["value"], "");
                assert_eq!(
                    read(&new_look).await.error.unwrap().code,
                    ErrorCode::SecureTextUnreadable
                );

                for live_role in [67, 40] {
                    role.send(Some(live_role)).unwrap();
                    let reply = read(&old_look).await;
                    assert_eq!(
                        reply.error.map(|error| error.code),
                        Some(ErrorCode::SecureTextUnreadable),
                        "role {live_role:?} unexpectedly authorized a read",
                    );
                    assert_eq!(reads.load(Ordering::SeqCst), permitted_reads);
                }

                role.send(Some(61)).unwrap();
                assert_eq!(
                    read(&old_look).await.result.unwrap()["text"],
                    "private fixture text"
                );
            },
        )
        .await;
    }

    #[tokio::test]
    async fn role_transition_during_get_text_drops_reply() {
        for next in [Some(40), Some(29), None] {
            let reads = Arc::new(AtomicUsize::new(0));
            let (role, current_role) = watch::channel(Some(61));
            let (state, root_ref) = peer_root_state();
            with_peer(
                |peer| {
                    peer.serve_at(
                        "/window",
                        PeerNode {
                            name: "Fixture",
                            role: current_role,
                            role_name: "text",
                            stalled_role: None,
                            stalled_children: None,
                            child: None,
                            parent: None,
                            text: true,
                        },
                    )?
                    .serve_at(
                        "/window",
                        PeerText {
                            reads: Arc::clone(&reads),
                            transition: Some((role.clone(), next)),
                        },
                    )
                },
                async |connection| {
                    let fresh = peer_request(
                        &state,
                        &connection,
                        "look",
                        json!({
                            "rootRef":root_ref,"includeImage":false,
                        }),
                    )
                    .await
                    .result
                    .unwrap();
                    assert_eq!(fresh["outline"]["value"], "", "post-read role {next:?}");
                    assert_eq!(fresh["outline"]["title"], "[protected]");
                    assert_eq!(reads.load(Ordering::SeqCst), 1);

                    // An earlier readable look must still use the live pre/post checks.
                    let mut target = node();
                    target.accessible = observed_root().accessible;
                    target.interfaces.insert(TEXT.into());
                    let (old_id, nodes) =
                        lock(&state)
                            .unwrap()
                            .insert_look(observed_root(), vec![target], None);
                    role.send(Some(61)).unwrap();
                    let read = peer_request(
                        &state,
                        &connection,
                        "atspiReadText",
                        json!({
                            "lookId":old_id,"elementRef":nodes[0].reference,
                        }),
                    )
                    .await;
                    assert_eq!(
                        read.error.map(|error| error.code),
                        Some(ErrorCode::SecureTextUnreadable)
                    );
                    assert_eq!(reads.load(Ordering::SeqCst), 2);
                },
            )
            .await;
        }
    }

    /// A text node with a fixed readable numeric role (61) and a live role name.
    struct RenamingNode(watch::Receiver<&'static str>);

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl RenamingNode {
        #[zbus(property)]
        fn name(&self) -> &str {
            "Fixture"
        }

        #[zbus(property)]
        fn description(&self) -> &str {
            ""
        }

        fn get_role_name(&self) -> zbus::fdo::Result<&'static str> {
            match *self.0.borrow() {
                FAILING_ROLE_NAME => Err(zbus::fdo::Error::Failed("role name unavailable".into())),
                name => Ok(name),
            }
        }

        fn get_role(&self) -> u32 {
            61
        }

        fn get_children(&self) -> Vec<(&str, OwnedObjectPath)> {
            Vec::new()
        }

        fn get_interfaces(&self) -> Vec<&str> {
            vec![TEXT]
        }
    }

    /// Rename the role, when set, while `GetText` runs; the numeric role never changes.
    struct RenamingText {
        reads: Arc<AtomicUsize>,
        rename: Option<(watch::Sender<&'static str>, &'static str)>,
    }

    #[zbus::interface(name = "org.a11y.atspi.Text")]
    impl RenamingText {
        fn get_text(&self, _start: i32, _end: i32) -> &str {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if let Some((name, next)) = &self.rename {
                name.send(next).unwrap();
            }
            "private fixture text"
        }
    }

    /// Text read under one role name is dropped when only the NAME changes during `GetText`.
    #[tokio::test]
    async fn role_name_change_during_get_text_drops_reply() {
        for next in ["password text", "entry", FAILING_ROLE_NAME] {
            let reads = Arc::new(AtomicUsize::new(0));
            let (name, live_name) = watch::channel("text");
            let (state, root_ref) = peer_root_state();
            with_peer(
                |peer| {
                    peer.serve_at("/window", RenamingNode(live_name))?.serve_at(
                        "/window",
                        RenamingText {
                            reads: Arc::clone(&reads),
                            rename: Some((name.clone(), next)),
                        },
                    )
                },
                async |connection| {
                    let fresh = peer_request(
                        &state,
                        &connection,
                        "look",
                        json!({"rootRef":root_ref,"includeImage":false}),
                    )
                    .await
                    .result
                    .unwrap();
                    assert_eq!(fresh["outline"]["value"], "", "renamed to {next:?}");
                    assert_eq!(fresh["outline"]["title"], "[protected]", "{next:?}");
                    assert_eq!(reads.load(Ordering::SeqCst), 1);

                    // A readable old look still needs both live role fields after the read.
                    let mut target = node();
                    target.accessible = observed_root().accessible;
                    target.interfaces.insert(TEXT.into());
                    let (old_id, nodes) =
                        lock(&state)
                            .unwrap()
                            .insert_look(observed_root(), vec![target], None);
                    name.send("text").unwrap();
                    let read = peer_request(
                        &state,
                        &connection,
                        "atspiReadText",
                        json!({"lookId":old_id,"elementRef":nodes[0].reference}),
                    )
                    .await;
                    assert_eq!(
                        read.error.map(|error| error.code),
                        Some(ErrorCode::SecureTextUnreadable),
                        "{next:?}"
                    );
                    assert_eq!(reads.load(Ordering::SeqCst), 2);
                },
            )
            .await;
        }
    }

    /// A readable old look cannot read once only the live role NAME contradicts the role.
    #[tokio::test]
    async fn old_look_cannot_read_after_a_live_role_name_change() {
        let reads = Arc::new(AtomicUsize::new(0));
        let (name, live_name) = watch::channel("text");
        let (state, root_ref) = peer_root_state();
        with_peer(
            |peer| {
                peer.serve_at("/window", RenamingNode(live_name))?.serve_at(
                    "/window",
                    RenamingText {
                        reads: Arc::clone(&reads),
                        rename: None,
                    },
                )
            },
            async |connection| {
                let look = peer_request(
                    &state,
                    &connection,
                    "look",
                    json!({"rootRef":root_ref,"includeImage":false}),
                )
                .await
                .result
                .unwrap();
                assert_eq!(look["outline"]["value"], "private fixture text");
                let read_args =
                    json!({"lookId":look["lookId"],"elementRef":look["outline"]["ref"]});
                let read = async || {
                    peer_request(&state, &connection, "atspiReadText", read_args.clone()).await
                };
                assert_eq!(read().await.result.unwrap()["text"], "private fixture text");
                let permitted_reads = reads.load(Ordering::SeqCst);
                name.send("unknown").unwrap();
                assert_eq!(
                    read().await.error.map(|error| error.code),
                    Some(ErrorCode::SecureTextUnreadable)
                );
                assert_eq!(reads.load(Ordering::SeqCst), permitted_reads);
            },
        )
        .await;
    }

    struct StalledMutation {
        stall: StalledReply,
        mutations: Arc<AtomicUsize>,
    }

    #[zbus::interface(name = "org.a11y.atspi.Action")]
    impl StalledMutation {
        #[zbus(property, name = "NActions")]
        fn n_actions(&self) -> i32 {
            1
        }

        async fn do_action(&self, index: i32) -> bool {
            assert_eq!(index, 0);
            self.mutations.fetch_add(1, Ordering::SeqCst);
            self.stall.wait().await
        }
    }

    struct StalledEdit(StalledMutation);

    #[zbus::interface(name = "org.a11y.atspi.EditableText")]
    impl StalledEdit {
        async fn set_text_contents(&self, text: &str) -> bool {
            assert_eq!(text, "replacement");
            self.0.mutations.fetch_add(1, Ordering::SeqCst);
            self.0.stall.wait().await
        }
    }

    #[tokio::test]
    async fn semantic_action_timeout_does_not_fall_back() {
        let (action_stall, mut actions) = StalledReply::new();
        let (edit_stall, mut edits) = StalledReply::new();
        let mutations = Arc::new(AtomicUsize::new(0));
        let (state, _) = peer_root_state();
        let mut target = node();
        target.bounds = Some(Rect {
            x: 130,
            y: 70,
            width: 40,
            height: 20,
        });
        target.interfaces.extend([
            "org.a11y.atspi.Action".into(),
            "org.a11y.atspi.EditableText".into(),
        ]);
        let (look_id, nodes) =
            lock(&state)
                .unwrap()
                .insert_look(observed_root(), vec![target], None);
        with_peer(
            |peer| peer.serve_at("/node", StalledMutation {stall:action_stall, mutations:Arc::clone(&mutations)})?
                .serve_at("/node", StalledEdit(StalledMutation {stall:edit_stall, mutations:Arc::clone(&mutations)})),
            async |connection| {
                let step = |action| json!({"lookId":look_id,"action":action,"target":{"ref":nodes[0].reference},"policy":"foreground","params":{"text":"replacement"}});
                let reply = peer_request(&state, &connection, "act", step("press")).await;
                assert_eq!(actions.try_recv(), Ok(()));
                assert!(!reply.ok);
                assert_eq!(reply.error.unwrap().code, ErrorCode::Timeout);
                assert_eq!(mutations.load(Ordering::SeqCst), 1);
                let batch = peer_request(&state, &connection, "actBatch", json!({"actions":[step("setText"),step("setText")]})).await.result.unwrap();
                assert_eq!(edits.try_recv(), Ok(()));
                assert_eq!(batch["outcome"], "unknown");
                assert_eq!(batch["stoppedAt"], 0);
                assert_eq!(batch["steps"].as_array().unwrap().len(), 1);
                assert_eq!(batch["steps"][0]["outcome"], "unknown");
                assert_eq!(batch["steps"][0]["error"]["code"], "timeout");
                assert_eq!(mutations.load(Ordering::SeqCst), 2);
            },
        ).await;
    }

    #[tokio::test]
    async fn a_request_admitted_after_cancellation_never_mutates() {
        let input = InputState::default();
        drop(begin_transaction("before", &input).await.unwrap());
        input.cancel();
        // The lock is free, so this request does not wait: it is refused all the same.
        assert_eq!(
            begin_transaction("after", &input).await.unwrap_err().code,
            ErrorCode::Cancelled
        );
        let (state, root_ref) = peer_root_state();
        for (cmd, args) in [
            (
                "act",
                json!({"lookId":"l1","action":"press","target":{"x":1,"y":1}}),
            ),
            ("actBatch", json!({"actions":[]})),
            ("focusWindow", json!({"rootRef":root_ref})),
            (
                "openBrowserLocation",
                json!({"url":"https://example.invalid/"}),
            ),
        ] {
            let reply = handle_request_with(
                &state,
                &Request {
                    protocol_version: PROTOCOL_VERSION,
                    id: "late".into(),
                    cmd: cmd.into(),
                    args,
                },
                &input,
                async || -> Result<AtspiClient, ProtocolError> { panic!("{cmd} connected") },
                |_, _, _, _, _, _| panic!("attempted physical input"),
            )
            .await;
            assert_eq!(
                reply.error.map(|error| error.code),
                Some(ErrorCode::Cancelled),
                "{cmd}"
            );
        }
    }

    /// An Action whose preparatory `NActions` read is where shutdown begins.
    struct CancelledDuringPreparation {
        input: Arc<InputState>,
        mutations: Arc<AtomicUsize>,
    }

    #[zbus::interface(name = "org.a11y.atspi.Action")]
    impl CancelledDuringPreparation {
        #[zbus(property, name = "NActions")]
        async fn n_actions(&self) -> i32 {
            self.input.cancel();
            1
        }

        async fn do_action(&self, _index: i32) -> bool {
            self.mutations.fetch_add(1, Ordering::SeqCst);
            true
        }
    }

    struct CountedEdit(Arc<AtomicUsize>);

    #[zbus::interface(name = "org.a11y.atspi.EditableText")]
    impl CountedEdit {
        async fn set_text_contents(&self, _text: &str) -> bool {
            self.0.fetch_add(1, Ordering::SeqCst);
            true
        }
    }

    #[tokio::test]
    async fn semantic_actions_check_shutdown_at_the_mutation() {
        let input = Arc::new(InputState::default());
        let mutations = Arc::new(AtomicUsize::new(0));
        let (state, _) = peer_root_state();
        let mut target = node();
        target.interfaces.extend([
            "org.a11y.atspi.Action".into(),
            "org.a11y.atspi.EditableText".into(),
        ]);
        let (look_id, nodes) =
            lock(&state)
                .unwrap()
                .insert_look(observed_root(), vec![target.clone()], None);
        with_peer(
            |peer| {
                peer.serve_at(
                    "/node",
                    CancelledDuringPreparation {
                        input: Arc::clone(&input),
                        mutations: Arc::clone(&mutations),
                    },
                )?
                .serve_at("/node", CountedEdit(Arc::clone(&mutations)))
            },
            async |connection| {
                let client = || {
                    AtspiClient::from_connection(connection.clone(), Duration::from_millis(250))
                        .with_input_state(Arc::clone(&input))
                };
                // Admitted before shutdown; shutdown begins during the preparatory read.
                let reply = handle_request_with(
                    &state,
                    &Request {
                        protocol_version: PROTOCOL_VERSION,
                        id: "press".into(),
                        cmd: "act".into(),
                        args: json!({"lookId":look_id,"action":"press","target":{"ref":nodes[0].reference},"policy":"foreground"}),
                    },
                    &input,
                    async || Ok(client()),
                    |_, _, _, _, _, _| panic!("attempted physical fallback"),
                )
                .await;
                assert_eq!(
                    reply.error.map(|error| error.code),
                    Some(ErrorCode::Cancelled)
                );
                // The text replacement checks the same boundary.
                assert_eq!(
                    client()
                        .set_text(&target, "replacement")
                        .await
                        .unwrap_err()
                        .code,
                    ErrorCode::Cancelled
                );
                assert_eq!(mutations.load(Ordering::SeqCst), 0, "no semantic mutation");
                // Before shutdown, the same calls do mutate.
                let live = AtspiClient::from_connection(connection.clone(), Duration::from_millis(250))
                    .with_input_state(Arc::new(InputState::default()));
                assert!(live.set_text(&target, "replacement").await.unwrap());
                assert_eq!(mutations.load(Ordering::SeqCst), 1);
            },
        )
        .await;
    }

    const CONTAINED_SECRET: &str = "private contained label";

    /// A readable text field inside a panel whose live role the test controls (#1233).
    fn serve_contained_field(
        peer: zbus::connection::Builder<'static>,
        panel_role: watch::Receiver<Option<u32>>,
        panel_role_name: &'static str,
        stalled_panel_role: Option<StalledReply>,
        field_parent: Option<(&'static str, &'static str)>,
        field_text: impl zbus::object_server::Interface,
    ) -> zbus::Result<zbus::connection::Builder<'static>> {
        peer.serve_at(
            "/window",
            PeerNode {
                name: "Window",
                role: watch::channel(Some(23)).1,
                role_name: "frame",
                stalled_role: None,
                stalled_children: None,
                child: Some("/window/panel"),
                parent: None,
                text: false,
            },
        )?
        .serve_at(
            "/window/panel",
            PeerNode {
                name: "Panel",
                role: panel_role,
                role_name: panel_role_name,
                stalled_role: stalled_panel_role,
                stalled_children: None,
                child: Some("/window/panel/field"),
                parent: Some((":1.1", "/window")),
                text: false,
            },
        )?
        .serve_at("/window/panel/field", contained_field(field_parent))?
        .serve_at("/window/panel/field", field_text)
    }

    fn contained_field(parent: Option<(&'static str, &'static str)>) -> PeerNode {
        PeerNode {
            name: CONTAINED_SECRET,
            role: watch::channel(Some(61)).1,
            role_name: "entry",
            stalled_role: None,
            stalled_children: None,
            child: None,
            parent,
            text: true,
        }
    }

    /// Field text that turns the panel protected during the next `GetText` once armed.
    struct ProtectingText {
        panel_role: Arc<watch::Sender<Option<u32>>>,
        armed: Arc<AtomicBool>,
    }

    #[zbus::interface(name = "org.a11y.atspi.Text")]
    impl ProtectingText {
        fn get_text(&self, _start: i32, _end: i32) -> &str {
            if self.armed.swap(false, Ordering::SeqCst) {
                self.panel_role.send(Some(PASSWORD_ROLE)).unwrap();
            }
            "private fixture text"
        }
    }

    /// A panel that turns protected while listing its children, during the next
    /// `GetChildren` once armed.
    struct ProtectingPanel {
        role: Arc<watch::Sender<Option<u32>>>,
        armed: Arc<AtomicBool>,
    }

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl ProtectingPanel {
        #[zbus(property)]
        fn name(&self) -> &str {
            "Panel"
        }

        #[zbus(property)]
        fn description(&self) -> &str {
            ""
        }

        fn get_role_name(&self) -> &str {
            "panel"
        }

        fn get_role(&self) -> zbus::fdo::Result<u32> {
            (*self.role.borrow()).ok_or_else(|| zbus::fdo::Error::Failed("role unavailable".into()))
        }

        fn get_children(&self) -> Vec<(&str, OwnedObjectPath)> {
            if self.armed.swap(false, Ordering::SeqCst) {
                self.role.send(Some(PASSWORD_ROLE)).unwrap();
            }
            vec![(
                ":1.1",
                OwnedObjectPath::try_from("/window/panel/field").unwrap(),
            )]
        }

        fn get_interfaces(&self) -> Vec<&str> {
            vec![]
        }

        #[zbus(property)]
        fn parent(&self) -> (&str, OwnedObjectPath) {
            (":1.1", OwnedObjectPath::try_from("/window").unwrap())
        }
    }

    /// A readable text field whose live `Parent` the test controls.
    struct MovingField {
        parent: watch::Receiver<&'static str>,
    }

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl MovingField {
        #[zbus(property)]
        fn name(&self) -> &str {
            CONTAINED_SECRET
        }

        #[zbus(property)]
        fn description(&self) -> &str {
            ""
        }

        fn get_role_name(&self) -> &str {
            "entry"
        }

        fn get_role(&self) -> u32 {
            61
        }

        fn get_children(&self) -> Vec<(&str, OwnedObjectPath)> {
            Vec::new()
        }

        fn get_interfaces(&self) -> Vec<&str> {
            vec![TEXT]
        }

        #[zbus(property)]
        fn parent(&self) -> (&str, OwnedObjectPath) {
            (
                ":1.1",
                OwnedObjectPath::try_from(*self.parent.borrow()).unwrap(),
            )
        }
    }

    /// Field text that moves the field under the protected vault during the next `GetText`
    /// once armed, without changing any role.
    struct MovingText {
        parent: Arc<watch::Sender<&'static str>>,
        armed: Arc<AtomicBool>,
    }

    #[zbus::interface(name = "org.a11y.atspi.Text")]
    impl MovingText {
        fn get_text(&self, _start: i32, _end: i32) -> &str {
            if self.armed.swap(false, Ordering::SeqCst) {
                self.parent.send("/window/vault").unwrap();
            }
            "private fixture text"
        }
    }

    const PASSWORD_ROLE: u32 = 40;
    /// A wait budget that a request resolving on its first snapshot never reaches.
    const FIRST_SNAPSHOT_WAIT_MS: u64 = 3_000;

    /// A scoped look and a scoped wait at `scope` of `look`.
    fn scoped_requests(root_ref: &str, look: &Value, scope: &Value) -> [(&'static str, Value); 2] {
        [
            (
                "look",
                json!({
                    "rootRef":root_ref,"includeImage":false,
                    "baseLookId":look["lookId"],"scopeRef":scope["ref"],
                }),
            ),
            (
                "atspiWaitFor",
                json!({
                    "rootRef":root_ref,"text":CONTAINED_SECRET,
                    "timeoutMs":FIRST_SNAPSHOT_WAIT_MS,
                    "lookId":look["lookId"],"scopeRef":scope["ref"],
                }),
            ),
        ]
    }

    /// The read paths that start below the root of `look` (window -> panel -> field): a
    /// scoped look and a scoped wait at the panel and at the field, and an explicit read of
    /// the field.
    fn contained_requests(root_ref: &str, look: &Value) -> Vec<(&'static str, Value)> {
        let panel = &look["outline"]["children"][0];
        let field = &panel["children"][0];
        let mut requests = Vec::from(scoped_requests(root_ref, look, panel));
        requests.extend(scoped_requests(root_ref, look, field));
        requests.push((
            "atspiReadText",
            json!({"lookId":look["lookId"],"elementRef":field["ref"]}),
        ));
        requests
    }

    async fn contained_reads(
        state: &Arc<Mutex<HelperState>>,
        connection: &Connection,
        root_ref: &str,
        look: &Value,
    ) -> Vec<Response> {
        let mut replies = Vec::new();
        for (cmd, args) in contained_requests(root_ref, look) {
            replies.push(peer_request(state, connection, cmd, args).await);
        }
        replies
    }

    #[tokio::test]
    async fn protected_container_protects_its_descendants() {
        for (protected, stalled, code) in [
            (Some(40), false, ErrorCode::SecureTextUnreadable),
            (Some(67), false, ErrorCode::SecureTextUnreadable),
            (Some(0), false, ErrorCode::SecureTextUnreadable),
            (None, false, ErrorCode::InternalError),
            (None, true, ErrorCode::Timeout),
        ] {
            let case = format!("panel role {protected:?}, stalled {stalled}");
            let reads = Arc::new(AtomicUsize::new(0));
            let (role, panel_role) = watch::channel(Some(39));
            let (stall, mut stalled_requests) = StalledReply::new();
            let (state, root_ref) = peer_root_state();
            with_peer(
                |peer| {
                    serve_contained_field(
                        peer,
                        panel_role,
                        "panel",
                        stalled.then_some(stall),
                        Some((":1.1", "/window/panel")),
                        PeerText::new(Arc::clone(&reads)),
                    )
                },
                async |connection| {
                    let look_args = json!({"rootRef":root_ref,"includeImage":false});
                    let look = peer_request(&state, &connection, "look", look_args.clone())
                        .await
                        .result
                        .unwrap();
                    let field = &look["outline"]["children"][0]["children"][0];
                    assert_eq!(field["title"], CONTAINED_SECRET, "{case}");
                    assert_eq!(field["value"], "private fixture text", "{case}");
                    let [panel_look, panel_wait, field_look, field_wait, read]: [Response; 5] =
                        contained_reads(&state, &connection, &root_ref, &look)
                            .await
                            .try_into()
                            .unwrap();
                    for scoped in [panel_look, field_look] {
                        let text = scoped.result.unwrap().to_string();
                        assert!(text.contains(CONTAINED_SECRET), "{case}");
                    }
                    for wait in [panel_wait, field_wait] {
                        assert_eq!(wait.result.unwrap()["found"], true, "{case}");
                    }
                    assert_eq!(read.result.unwrap()["text"], "private fixture text");

                    role.send(protected).unwrap();
                    let permitted_reads = reads.load(Ordering::SeqCst);
                    let fresh = peer_request(&state, &connection, "look", look_args.clone())
                        .await
                        .result
                        .unwrap();
                    let text = fresh.to_string();
                    assert!(!text.contains(CONTAINED_SECRET), "{case}: {text}");
                    assert!(!text.contains("private fixture text"), "{case}: {text}");
                    let panel = &fresh["outline"]["children"][0];
                    assert_eq!(panel["title"], "[protected]", "{case}");
                    assert_eq!(panel["truncated"], true, "{case}");
                    assert_eq!(panel["children"], json!([]), "{case}");
                    // The refs of the earlier, readable look no longer reach the field, and a
                    // protected scope refuses rather than returning a redacted node.
                    while stalled_requests.try_recv().is_ok() {}
                    for reply in contained_reads(&state, &connection, &root_ref, &look).await {
                        assert!(!reply.ok, "{case}: {reply:?}");
                        assert_eq!(reply.error.unwrap().code, code, "{case}");
                    }
                    if stalled {
                        // Each of the five refuses at its first read of the panel's role,
                        // before reading anything at or below the scope.
                        let mut stalls = 0;
                        while stalled_requests.try_recv().is_ok() {
                            stalls += 1;
                        }
                        assert_eq!(stalls, 5, "{case}");
                    }
                    let unscoped = peer_request(
                        &state,
                        &connection,
                        "atspiWaitFor",
                        json!({"rootRef":root_ref,"text":CONTAINED_SECRET,"timeoutMs":100}),
                    )
                    .await
                    .result
                    .unwrap();
                    assert_eq!(unscoped["found"], false, "{case}");
                    let gone = peer_request(
                        &state,
                        &connection,
                        "atspiWaitFor",
                        json!({"rootRef":root_ref,"text":CONTAINED_SECRET,"gone":true}),
                    )
                    .await;
                    assert_eq!(gone.error.unwrap().code, ErrorCode::Timeout, "{case}");
                    assert_eq!(reads.load(Ordering::SeqCst), permitted_reads, "{case}");

                    role.send(Some(39)).unwrap();
                    let replies = contained_reads(&state, &connection, &root_ref, &look).await;
                    assert_eq!(
                        replies[4].result.as_ref().unwrap()["text"],
                        "private fixture text"
                    );
                },
            )
            .await;
        }
    }

    /// A container that turns protected while its descendant is read, or while its children
    /// are listed, discards what was read below it.
    #[tokio::test]
    async fn container_protected_during_a_contained_read_discards_it() {
        let (role, panel_role) = watch::channel(Some(39));
        let role = Arc::new(role);
        let armed = Arc::new(AtomicBool::new(false));
        let (state, root_ref) = peer_root_state();
        with_peer(
            |peer| {
                serve_contained_field(
                    peer,
                    panel_role,
                    "panel",
                    None,
                    Some((":1.1", "/window/panel")),
                    ProtectingText {
                        panel_role: Arc::clone(&role),
                        armed: Arc::clone(&armed),
                    },
                )
            },
            async |connection| {
                let look_args = json!({"rootRef":root_ref,"includeImage":false});
                let look = peer_request(&state, &connection, "look", look_args.clone())
                    .await
                    .result
                    .unwrap();
                let field = &look["outline"]["children"][0]["children"][0];
                assert_eq!(field["title"], CONTAINED_SECRET);
                for (cmd, args) in contained_requests(&root_ref, &look) {
                    role.send(Some(39)).unwrap();
                    armed.store(true, Ordering::SeqCst);
                    let reply = peer_request(&state, &connection, cmd, args).await;
                    assert!(!armed.load(Ordering::SeqCst), "{cmd} never read the text");
                    assert!(!reply.ok, "{cmd}: {reply:?}");
                    assert!(
                        !format!("{reply:?}").contains("private fixture text"),
                        "{cmd}"
                    );
                    assert_eq!(
                        reply.error.unwrap().code,
                        ErrorCode::SecureTextUnreadable,
                        "{cmd}"
                    );
                }
                // Neither a full look nor a scope at the root, whose own checks pass, returns
                // what was read below the panel: it is redacted and its subtree dropped.
                let root_scope = &look["outline"];
                let [scoped_look, (_, mut scoped_wait)] =
                    scoped_requests(&root_ref, &look, root_scope);
                scoped_wait["timeoutMs"] = json!(100);
                for (cmd, args) in [
                    ("look", look_args),
                    scoped_look,
                    ("atspiWaitFor", scoped_wait),
                ] {
                    role.send(Some(39)).unwrap();
                    armed.store(true, Ordering::SeqCst);
                    let reply = peer_request(&state, &connection, cmd, args).await;
                    assert!(!armed.load(Ordering::SeqCst), "{cmd} never read the text");
                    let result = reply.result.unwrap();
                    let text = result.to_string();
                    assert!(!text.contains(CONTAINED_SECRET), "{cmd}: {text}");
                    assert!(!text.contains("private fixture text"), "{cmd}: {text}");
                    if cmd == "look" {
                        let panel = &result["outline"]["children"][0];
                        assert_eq!(panel["title"], "[protected]", "{text}");
                        assert_eq!(panel["truncated"], true, "{text}");
                        assert_eq!(panel["children"], json!([]), "{text}");
                    } else {
                        assert_eq!(result["found"], false, "{text}");
                    }
                }
            },
        )
        .await;

        // The panel turns protected while listing the field: the field is never read.
        let (role, _panel_role) = watch::channel(Some(39));
        let role = Arc::new(role);
        let reads = Arc::new(AtomicUsize::new(0));
        with_peer(
            |peer| {
                peer.serve_at(
                    "/window",
                    PeerNode {
                        name: "Window",
                        role: watch::channel(Some(23)).1,
                        role_name: "frame",
                        stalled_role: None,
                        stalled_children: None,
                        child: Some("/window/panel"),
                        parent: None,
                        text: false,
                    },
                )?
                .serve_at(
                    "/window/panel",
                    ProtectingPanel {
                        role: Arc::clone(&role),
                        armed: Arc::clone(&armed),
                    },
                )?
                .serve_at(
                    "/window/panel/field",
                    contained_field(Some((":1.1", "/window/panel"))),
                )?
                .serve_at("/window/panel/field", PeerText::new(Arc::clone(&reads)))
            },
            async |connection| {
                let look_args = json!({"rootRef":root_ref,"includeImage":false});
                let look = peer_request(&state, &connection, "look", look_args.clone())
                    .await
                    .result
                    .unwrap();
                let panel = &look["outline"]["children"][0];
                assert_eq!(panel["children"][0]["title"], CONTAINED_SECRET);
                let permitted_reads = reads.load(Ordering::SeqCst);
                let [panel_look, _] = scoped_requests(&root_ref, &look, panel);
                let [root_look, _] = scoped_requests(&root_ref, &look, &look["outline"]);
                for (cmd, args) in [("look", look_args), panel_look, root_look] {
                    role.send(Some(39)).unwrap();
                    armed.store(true, Ordering::SeqCst);
                    let reply = peer_request(&state, &connection, cmd, args.clone()).await;
                    assert!(
                        !armed.load(Ordering::SeqCst),
                        "{args} never listed the field"
                    );
                    assert!(!format!("{reply:?}").contains(CONTAINED_SECRET), "{args}");
                    assert_eq!(reads.load(Ordering::SeqCst), permitted_reads, "{args}");
                    if args.get("scopeRef") == Some(&panel["ref"]) {
                        // The scope itself turned protected: refuse, not a redacted panel.
                        let code = reply.error.unwrap().code;
                        assert_eq!(code, ErrorCode::SecureTextUnreadable, "{args}");
                    } else {
                        let result = reply.result.unwrap();
                        let panel = &result["outline"]["children"][0];
                        assert_eq!(panel["title"], "[protected]", "{args}");
                        assert_eq!(panel["truncated"], true, "{args}");
                        assert_eq!(panel["children"], json!([]), "{args}");
                    }
                }
            },
        )
        .await;

        // The field moves under a protected vault while its text is read, and no role changes:
        // neither a full look nor a scope at the root or at the readable panel it left, whose
        // own ancestry checks all pass, returns what was read.
        let (parent, field_parent) = watch::channel("/window/panel");
        let parent = Arc::new(parent);
        with_peer(
            |peer| {
                peer.serve_at(
                    "/window",
                    PeerNode {
                        name: "Window",
                        role: watch::channel(Some(23)).1,
                        role_name: "frame",
                        stalled_role: None,
                        stalled_children: None,
                        child: Some("/window/panel"),
                        parent: None,
                        text: false,
                    },
                )?
                .serve_at(
                    "/window/panel",
                    PeerNode {
                        name: "Panel",
                        role: watch::channel(Some(39)).1,
                        role_name: "panel",
                        stalled_role: None,
                        stalled_children: None,
                        child: Some("/window/panel/field"),
                        parent: Some((":1.1", "/window")),
                        text: false,
                    },
                )?
                .serve_at(
                    "/window/vault",
                    PeerNode {
                        name: "Vault",
                        role: watch::channel(Some(PASSWORD_ROLE)).1,
                        role_name: "password text",
                        stalled_role: None,
                        stalled_children: None,
                        child: Some("/window/panel/field"),
                        parent: Some((":1.1", "/window")),
                        text: false,
                    },
                )?
                .serve_at(
                    "/window/panel/field",
                    MovingField {
                        parent: field_parent,
                    },
                )?
                .serve_at(
                    "/window/panel/field",
                    MovingText {
                        parent: Arc::clone(&parent),
                        armed: Arc::clone(&armed),
                    },
                )
            },
            async |connection| {
                let look_args = json!({"rootRef":root_ref,"includeImage":false});
                let look = peer_request(&state, &connection, "look", look_args.clone())
                    .await
                    .result
                    .unwrap();
                let panel = &look["outline"]["children"][0];
                assert_eq!(panel["children"][0]["title"], CONTAINED_SECRET);
                let [panel_look, _] = scoped_requests(&root_ref, &look, panel);
                let [root_look, (_, mut root_wait)] =
                    scoped_requests(&root_ref, &look, &look["outline"]);
                root_wait["timeoutMs"] = json!(100);
                for (cmd, args) in [
                    ("look", look_args),
                    panel_look,
                    root_look,
                    ("atspiWaitFor", root_wait),
                ] {
                    parent.send("/window/panel").unwrap();
                    armed.store(true, Ordering::SeqCst);
                    let reply = peer_request(&state, &connection, cmd, args.clone()).await;
                    assert!(!armed.load(Ordering::SeqCst), "{args} never read the text");
                    let result = reply.result.unwrap();
                    let text = result.to_string();
                    assert!(!text.contains(CONTAINED_SECRET), "{args}: {text}");
                    assert!(!text.contains("private fixture text"), "{args}: {text}");
                    if cmd == "atspiWaitFor" {
                        assert_eq!(result["found"], false, "{text}");
                        continue;
                    }
                    let left = if args.get("scopeRef") == Some(&panel["ref"]) {
                        &result["outline"]
                    } else {
                        &result["outline"]["children"][0]
                    };
                    assert_eq!(left["title"], "Panel", "{text}");
                    assert_eq!(left["truncated"], true, "{text}");
                    assert_eq!(left["children"], json!([]), "{text}");
                }
            },
        )
        .await;
    }

    /// A `GetChildren` edge is followed only when the child's live `Parent`, when readable, is
    /// the node that listed it: a readable sibling that also lists a field never exposes a
    /// field whose live parent is protected.
    #[tokio::test]
    async fn get_children_alias_never_bypasses_a_protected_parent() {
        for (field_parent, visible) in [
            ((":1.1", "/window/sibling"), true),
            ((":1.1", "/window/panel"), false),
            // A `Parent` that never replies does not confirm the sibling's edge.
            (STALLED_PARENT, false),
        ] {
            let reads = Arc::new(AtomicUsize::new(0));
            let (state, root_ref) = peer_root_state();
            with_peer(
                |peer| {
                    peer.serve_at(
                        "/window",
                        PeerNode {
                            name: "Window",
                            role: watch::channel(Some(23)).1,
                            role_name: "frame",
                            stalled_role: None,
                            stalled_children: None,
                            child: Some("/window/sibling"),
                            parent: None,
                            text: false,
                        },
                    )?
                    .serve_at(
                        "/window/sibling",
                        PeerNode {
                            name: "Sibling",
                            role: watch::channel(Some(39)).1,
                            role_name: "panel",
                            stalled_role: None,
                            stalled_children: None,
                            child: Some("/window/panel/field"),
                            parent: Some((":1.1", "/window")),
                            text: false,
                        },
                    )?
                    .serve_at(
                        "/window/panel",
                        PeerNode {
                            name: "Password panel",
                            role: watch::channel(Some(PASSWORD_ROLE)).1,
                            role_name: "password text",
                            stalled_role: None,
                            stalled_children: None,
                            child: Some("/window/panel/field"),
                            parent: Some((":1.1", "/window")),
                            text: false,
                        },
                    )?
                    .serve_at("/window/panel/field", contained_field(Some(field_parent)))?
                    .serve_at("/window/panel/field", PeerText::new(Arc::clone(&reads)))
                },
                async |connection| {
                    let look = peer_request(
                        &state,
                        &connection,
                        "look",
                        json!({"rootRef":root_ref,"includeImage":false}),
                    )
                    .await
                    .result
                    .unwrap();
                    let text = look.to_string();
                    assert_eq!(text.contains(CONTAINED_SECRET), visible, "{text}");
                    let sibling = &look["outline"]["children"][0];
                    assert_eq!(sibling["title"], "Sibling");
                    assert_eq!(sibling["truncated"], !visible, "{text}");
                    let [scoped, _] = scoped_requests(&root_ref, &look, sibling);
                    let scoped = peer_request(&state, &connection, scoped.0, scoped.1).await;
                    let scoped = scoped.result.unwrap().to_string();
                    assert_eq!(scoped.contains(CONTAINED_SECRET), visible, "{scoped}");
                    // Only the hidden case actually waits out its budget.
                    let budget = if visible { FIRST_SNAPSHOT_WAIT_MS } else { 100 };
                    let wait = peer_request(
                        &state,
                        &connection,
                        "atspiWaitFor",
                        json!({"rootRef":root_ref,"text":CONTAINED_SECRET,"timeoutMs":budget}),
                    )
                    .await;
                    assert_eq!(wait.result.unwrap()["found"], visible, "{field_parent:?}");
                    assert_eq!(
                        reads.load(Ordering::SeqCst) > 0,
                        visible,
                        "{field_parent:?}"
                    );
                },
            )
            .await;
        }
    }

    /// A readable window that lists `/window/<index>` children, `0..self.0`.
    struct WideWindow(usize);

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl WideWindow {
        #[zbus(property)]
        fn name(&self) -> &str {
            "Window"
        }

        #[zbus(property)]
        fn description(&self) -> &str {
            ""
        }

        fn get_role_name(&self) -> &str {
            "frame"
        }

        fn get_role(&self) -> u32 {
            23
        }

        fn get_children(&self) -> Vec<(&str, OwnedObjectPath)> {
            (0..self.0)
                .map(|index| {
                    let path = format!("/window/{index}");
                    (":1.1", OwnedObjectPath::try_from(path).unwrap())
                })
                .collect()
        }

        fn get_interfaces(&self) -> Vec<&str> {
            vec![]
        }
    }

    /// Serial `Parent` checks that each stall up to the request deadline still end within one
    /// snapshot deadline, as a snapshot-level `timeout` and never a partial snapshot: unscoped,
    /// scoped at the root, and scoped below it, where the budget runs out during the ancestry
    /// checks themselves (#1349).
    #[tokio::test]
    async fn snapshot_parent_checks_respect_operation_deadline() {
        const CHILDREN: usize = 8;
        // Five times the snapshot deadline, so only a missing deadline reaches it, not a slow
        // runner; `with_peer` bounds the whole test at 5 s. Unbounded, the edge checks alone
        // take CHILDREN * 250 ms = 2 s, and the below-root scope a minute.
        const WATCHDOG: Duration = Duration::from_secs(3);
        with_peer(
            |peer| {
                let mut peer = peer.serve_at("/window", WideWindow(CHILDREN))?;
                for index in 0..CHILDREN {
                    let mut child = contained_field(Some(STALLED_PARENT));
                    child.name = "Child";
                    peer = peer.serve_at(format!("/window/{index}"), child)?;
                }
                Ok(peer)
            },
            async |connection| {
                let root = AccessibleRef {
                    destination: ":1.1".into(),
                    path: "/window".into(),
                };
                let below = AccessibleRef {
                    destination: ":1.1".into(),
                    path: "/window/0".into(),
                };
                let snapshot_timeout = Duration::from_millis(600);
                // Each stalled `Parent` gives up at 250 ms, so only the sum outlasts the snapshot.
                let client =
                    AtspiClient::from_connection(connection.clone(), Duration::from_millis(250))
                        .with_snapshot_timeout(snapshot_timeout);
                // A per-request deadline past the watchdog: the below-root scope's first ancestry
                // `Parent` read stalls, so only a snapshot deadline that covers it ends the look.
                let patient = AtspiClient::from_connection(connection, Duration::from_secs(60))
                    .with_snapshot_timeout(snapshot_timeout);
                for case in ["unscoped", "root scope", "below-root scope"] {
                    let reply = match case {
                        "unscoped" => {
                            tokio::time::timeout(WATCHDOG, client.snapshot_from(&root, 64, 4)).await
                        }
                        "root scope" => {
                            let snapshot = client.snapshot_within(&root, &root, 64, 4);
                            tokio::time::timeout(WATCHDOG, snapshot).await
                        }
                        _ => {
                            let snapshot = patient.snapshot_within(&root, &below, 64, 4);
                            tokio::time::timeout(WATCHDOG, snapshot).await
                        }
                    };
                    let Ok(reply) = reply else {
                        panic!("{case}: no snapshot deadline within {WATCHDOG:?}");
                    };
                    let Err(error) = reply else {
                        panic!("{case}: a snapshot past its deadline returned nodes");
                    };
                    assert_eq!(error.code, ErrorCode::Timeout, "{case}: {error:?}");
                    // The snapshot's own deadline, not a single request's (`Parent timed out`).
                    assert_eq!(error.message, "AT-SPI2 snapshot timed out", "{case}");
                }
            },
        )
        .await;
    }

    /// A link in a straight chain of readable panels; the leaf has text.
    struct ChainNode {
        parent: String,
        child: Option<String>,
        text: bool,
    }

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl ChainNode {
        #[zbus(property)]
        fn name(&self) -> &str {
            "Link"
        }

        #[zbus(property)]
        fn description(&self) -> &str {
            ""
        }

        fn get_role_name(&self) -> &str {
            "panel"
        }

        fn get_role(&self) -> u32 {
            39
        }

        fn get_children(&self) -> Vec<(&str, OwnedObjectPath)> {
            self.child
                .iter()
                .map(|path| (":1.1", OwnedObjectPath::try_from(path.as_str()).unwrap()))
                .collect()
        }

        fn get_interfaces(&self) -> Vec<&str> {
            if self.text {
                vec![TEXT]
            } else {
                vec![]
            }
        }

        #[zbus(property)]
        fn parent(&self) -> (&str, OwnedObjectPath) {
            (
                ":1.1",
                OwnedObjectPath::try_from(self.parent.as_str()).unwrap(),
            )
        }
    }

    #[tokio::test]
    async fn unconfirmed_ancestry_refuses_contained_reads() {
        const PANEL: Option<(&str, &str)> = Some((":1.1", "/window/panel"));
        // (field `Parent`, panel role name, field reads' code, panel scopes' code, full look
        // discloses the field)
        for (field_parent, panel_role_name, code, panel_code, discloses) in [
            (
                PANEL,
                FAILING_ROLE_NAME,
                ErrorCode::InternalError,
                Some(ErrorCode::InternalError),
                false,
            ),
            (
                PANEL,
                "  ",
                ErrorCode::SecureTextUnreadable,
                Some(ErrorCode::SecureTextUnreadable),
                false,
            ),
            // Only a provider that does not implement `Parent` keeps its `GetChildren` edges;
            // an explicit read still needs the live ancestry.
            (None, "panel", ErrorCode::InternalError, None, true),
            // A `Parent` that fails, fast or by timing out, does not confirm the edge.
            (
                Some(FAILING_PARENT),
                "panel",
                ErrorCode::InternalError,
                None,
                false,
            ),
            (
                Some(STALLED_PARENT),
                "panel",
                ErrorCode::Timeout,
                None,
                false,
            ),
            (
                Some((":1.2", "/window/panel")),
                "panel",
                ErrorCode::SecureTextUnreadable,
                None,
                false,
            ),
            (
                Some(("", "/org/a11y/atspi/null")),
                "panel",
                ErrorCode::SecureTextUnreadable,
                None,
                false,
            ),
            (
                Some((":1.1", "/window/panel/field")),
                "panel",
                ErrorCode::SecureTextUnreadable,
                None,
                false,
            ),
        ] {
            let case = format!("{field_parent:?} {panel_role_name:?}");
            let reads = Arc::new(AtomicUsize::new(0));
            let (state, root_ref) = peer_root_state();
            // The refs come from a look while the ancestry is still confirmed.
            let look = with_peer(
                |peer| {
                    serve_contained_field(
                        peer,
                        watch::channel(Some(39)).1,
                        "panel",
                        None,
                        PANEL,
                        PeerText::new(Arc::clone(&reads)),
                    )
                },
                async |connection| {
                    let args = json!({"rootRef":root_ref,"includeImage":false,"readText":"never"});
                    peer_request(&state, &connection, "look", args)
                        .await
                        .result
                        .unwrap()
                },
            )
            .await;
            let field = &look["outline"]["children"][0]["children"][0];
            assert_eq!(field["title"], CONTAINED_SECRET, "{case}");
            with_peer(
                |peer| {
                    serve_contained_field(
                        peer,
                        watch::channel(Some(39)).1,
                        panel_role_name,
                        None,
                        field_parent,
                        PeerText::new(Arc::clone(&reads)),
                    )
                },
                async |connection| {
                    let args = json!({"rootRef":root_ref,"includeImage":false,"readText":"never"});
                    let fresh = peer_request(&state, &connection, "look", args)
                        .await
                        .result
                        .unwrap()
                        .to_string();
                    assert_eq!(
                        fresh.contains(CONTAINED_SECRET),
                        discloses,
                        "{case}: {fresh}"
                    );
                    let mut requests = contained_requests(&root_ref, &look);
                    let field_requests = requests.split_off(2);
                    for (cmd, args) in requests {
                        if panel_code.is_none() && cmd == "atspiWaitFor" {
                            continue;
                        }
                        let reply = peer_request(&state, &connection, cmd, args).await;
                        if let Some(panel_code) = panel_code {
                            assert!(!reply.ok, "{case}: {reply:?}");
                            assert_eq!(reply.error.unwrap().code, panel_code, "{case}");
                        } else if cmd == "look" {
                            // The panel scope is readable; the field below it is not reached.
                            let scoped = reply.result.unwrap().to_string();
                            assert_eq!(scoped.contains(CONTAINED_SECRET), discloses, "{case}");
                        }
                    }
                    let permitted_reads = reads.load(Ordering::SeqCst);
                    for (cmd, args) in field_requests {
                        let reply = peer_request(&state, &connection, cmd, args).await;
                        assert!(!reply.ok, "{case}: {reply:?}");
                        assert_eq!(reply.error.unwrap().code, code, "{case}");
                    }
                    assert_eq!(reads.load(Ordering::SeqCst), permitted_reads, "{case}");
                },
            )
            .await;
        }

        // The depth bound: a node `links` `Parent` links below the root.
        for (links, readable) in [(255, true), (256, true), (257, false)] {
            let reads = Arc::new(AtomicUsize::new(0));
            let (state, _) = peer_root_state();
            let path = |index: usize| {
                if index == 0 {
                    "/window".to_owned()
                } else {
                    format!("/window/link{index}")
                }
            };
            let mut leaf = node();
            leaf.accessible = AccessibleRef {
                destination: ":1.1".into(),
                path: path(links),
            };
            leaf.interfaces.insert(TEXT.into());
            let (look_id, nodes) =
                lock(&state)
                    .unwrap()
                    .insert_look(observed_root(), vec![leaf], None);
            with_peer(
                |mut peer| {
                    for index in 0..=links {
                        peer = peer.serve_at(
                            path(index),
                            ChainNode {
                                parent: path(index.saturating_sub(1)),
                                child: (index < links).then(|| path(index + 1)),
                                text: index == links,
                            },
                        )?;
                    }
                    peer.serve_at(path(links), PeerText::new(Arc::clone(&reads)))
                },
                async |connection| {
                    let reply = peer_request(
                        &state,
                        &connection,
                        "atspiReadText",
                        json!({"lookId":look_id,"elementRef":nodes[0].reference}),
                    )
                    .await;
                    if readable {
                        assert_eq!(reply.result.unwrap()["text"], "private fixture text");
                    } else {
                        let code = reply.error.unwrap().code;
                        assert_eq!(code, ErrorCode::SecureTextUnreadable, "{links} links");
                        assert_eq!(reads.load(Ordering::SeqCst), 0, "{links} links");
                    }
                },
            )
            .await;
        }
    }

    #[tokio::test]
    async fn wait_for_gone_rejects_incomplete_snapshot() {
        let (stall, mut requests) = StalledReply::new();
        let (state, root_ref) = peer_root_state();
        for stalled in [None, Some(stall)] {
            let incomplete = stalled.is_some();
            with_peer(
                |peer| {
                    peer.serve_at(
                        "/window",
                        PeerNode {
                            name: "Window",
                            role: watch::channel(Some(23)).1,
                            role_name: "frame",
                            stalled_role: None,
                            stalled_children: None,
                            child: Some("/window/parent"),
                            parent: None,
                            text: false,
                        },
                    )?
                    .serve_at(
                        "/window/parent",
                        PeerNode {
                            name: "Parent",
                            role: watch::channel(Some(39)).1,
                            role_name: "panel",
                            stalled_role: None,
                            stalled_children: stalled,
                            child: Some("/window/parent/match"),
                            parent: None,
                            text: false,
                        },
                    )?
                    .serve_at(
                        "/window/parent/match",
                        PeerNode {
                            name: "Matching child",
                            role: watch::channel(Some(29)).1,
                            role_name: "label",
                            stalled_role: None,
                            stalled_children: None,
                            child: None,
                            parent: None,
                            text: false,
                        },
                    )
                },
                async |connection| {
                    if incomplete {
                        let reply = peer_request(
                            &state,
                            &connection,
                            "atspiWaitFor",
                            json!({"rootRef":root_ref,"text":"Matching child","gone":true}),
                        )
                        .await;
                        assert_eq!(requests.try_recv(), Ok(()));
                        assert!(!reply.ok);
                        assert_eq!(reply.error.unwrap().code, ErrorCode::Timeout);
                        let look = peer_request(
                            &state,
                            &connection,
                            "look",
                            json!({"rootRef":root_ref,"includeImage":false}),
                        )
                        .await
                        .result
                        .unwrap();
                        assert_eq!(look["outline"]["title"], "Window");
                        // The stalled parent is unread, not a leaf: the outline must say so.
                        assert_eq!(look["outline"]["truncated"], false);
                        let parent = &look["outline"]["children"][0];
                        assert_eq!(parent["title"], "Parent");
                        assert_eq!(parent["truncated"], true);
                        assert_eq!(parent["children"], json!([]));
                    } else {
                        let reply = peer_request(
                            &state,
                            &connection,
                            "atspiWaitFor",
                            json!({"rootRef":root_ref,"text":"Matching child"}),
                        )
                        .await;
                        assert_eq!(reply.result.unwrap()["found"], true);
                        let gone = peer_request(
                            &state,
                            &connection,
                            "atspiWaitFor",
                            json!({"rootRef":root_ref,"text":"Absent child","gone":true}),
                        )
                        .await;
                        assert_eq!(gone.result.unwrap()["gone"], true);
                        let look = peer_request(
                            &state,
                            &connection,
                            "look",
                            json!({"rootRef":root_ref,"includeImage":false}),
                        )
                        .await
                        .result
                        .unwrap();
                        let parent = &look["outline"]["children"][0];
                        assert_eq!(parent["truncated"], false);
                        assert_eq!(parent["children"][0]["title"], "Matching child");
                    }
                },
            )
            .await;
        }
    }

    #[tokio::test]
    async fn wait_for_gone_rejects_unread_role_name() {
        let (state, root_ref) = peer_root_state();
        for role_name in ["label", "", "  ", FAILING_ROLE_NAME] {
            let complete = role_name == "label";
            with_peer(
                |peer| {
                    peer.serve_at(
                        "/window",
                        PeerNode {
                            name: "Window",
                            role: watch::channel(Some(23)).1,
                            role_name: "frame",
                            stalled_role: None,
                            stalled_children: None,
                            child: Some("/window/label"),
                            parent: None,
                            text: false,
                        },
                    )?
                    .serve_at(
                        "/window/label",
                        PeerNode {
                            name: "Status",
                            role: watch::channel(Some(29)).1,
                            role_name,
                            stalled_role: None,
                            stalled_children: None,
                            child: None,
                            parent: None,
                            text: false,
                        },
                    )
                },
                async |connection| {
                    let reply = peer_request(
                        &state,
                        &connection,
                        "atspiWaitFor",
                        json!({"rootRef":root_ref,"role":"label","gone":true,"timeoutMs":300}),
                    )
                    .await;
                    if complete {
                        // Still present: the wait times out without claiming `gone`.
                        let result = reply.result.unwrap();
                        assert_eq!(result["gone"], Value::Null);
                        assert_eq!(result["timedOut"], true);
                    } else {
                        assert!(!reply.ok, "{role_name:?} proved absence: {reply:?}");
                        assert_eq!(reply.error.unwrap().code, ErrorCode::Timeout);
                    }
                    let look = peer_request(
                        &state,
                        &connection,
                        "look",
                        json!({"rootRef":root_ref,"includeImage":false}),
                    )
                    .await
                    .result
                    .unwrap();
                    let label = &look["outline"]["children"][0];
                    assert_eq!(label["title"], "Status", "{role_name:?}");
                    assert_eq!(label["truncated"], !complete, "{role_name:?}");
                },
            )
            .await;
        }
    }

    #[test]
    fn semantic_delivery_uses_shared_ax_label() {
        assert_eq!(semantic_performed()["delivery"], "ax");
        assert_eq!(semantic_performed()["grounding"], "description");
    }

    #[test]
    fn matching_is_case_insensitive_and_conjunctive() {
        let node = node();
        assert!(matches_node(
            &node,
            &Some("SAVE".to_lowercase()),
            &Some("push button".into()),
            &None
        ));
        assert!(!matches_node(
            &node,
            &Some("save".into()),
            &Some("checkbox".into()),
            &None
        ));
    }

    #[test]
    fn request_id_is_recovered_from_invalid_envelope() {
        assert_eq!(
            extract_id(r#"{"id":"abc","oops":1}"#).as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn successful_portal_diagnostics_are_capabilities_only() {
        let value = portal_diagnostics(Some(Ok(PortalCapabilities {
            remote_desktop_version: 2,
            screen_cast_version: 6,
            available_device_types: 3,
            available_source_types: 3,
            available_cursor_modes: 5,
        })));
        assert_eq!(value["available"], true);
        assert_eq!(value["interactiveUseEnabled"], false);
        assert_eq!(value["readOnlyProbe"], true);
        assert_eq!(value["remoteDesktopVersion"], 2);
        assert_eq!(value["screenCastVersion"], 6);
        assert_eq!(value["availableDeviceTypes"], 3);
        assert_eq!(value["availableSourceTypes"], 3);
        assert_eq!(value["availableCursorModes"], 5);
    }

    #[test]
    fn failed_portal_probe_is_reported_without_enabling_portal_use() {
        let value = portal_diagnostics(Some(Err(PortalError::Unavailable(
            "no portal service".into(),
        ))));
        assert_eq!(value["available"], false);
        assert_eq!(value["interactiveUseEnabled"], false);
        assert_eq!(value["error"]["kind"], "portal_unavailable");
        assert!(value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no portal service"));
    }

    #[test]
    fn non_wayland_diagnostics_skip_the_portal_probe() {
        let value = portal_diagnostics(None);
        assert_eq!(value["probed"], false);
        assert_eq!(value["reason"], "not_wayland");
        assert_eq!(value["interactiveUseEnabled"], false);
    }

    #[test]
    fn scoped_no_image_keeps_downscaled_coordinate_mapping() {
        let mut root = RootSnapshot {
            accessible: AccessibleRef {
                destination: ":1.1".into(),
                path: "/window".into(),
            },
            pid: 1,
            name: "Window".into(),
            app_name: "App".into(),
            executable: None,
            wm_class: None,
            class_candidates: Vec::new(),
            role: "frame".into(),
            frame: Some(Rect {
                x: 100,
                y: 200,
                width: 2000,
                height: 1000,
            }),
            x11_window: None,
            is_focused: false,
            is_minimized: false,
            z_order: None,
        };
        let base_size = initial_image_size(&root, Some((1000, 500)));
        let base_point = image_point_to_screen(
            root.frame.as_ref().unwrap(),
            base_size.0,
            base_size.1,
            250.0,
            125.0,
        )
        .unwrap();
        root.name = "Scoped expansion".into();
        let scoped_size = initial_image_size(&root, Some(base_size));
        let scoped_point = image_point_to_screen(
            root.frame.as_ref().unwrap(),
            scoped_size.0,
            scoped_size.1,
            250.0,
            125.0,
        )
        .unwrap();
        assert_eq!(scoped_size, (1000, 500));
        assert_eq!(scoped_point, base_point);
    }

    #[test]
    fn downscaled_image_coordinates_map_back_to_window_points() {
        let frame = Rect {
            x: 100,
            y: 200,
            width: 2000,
            height: 1000,
        };
        assert_eq!(
            image_point_to_screen(&frame, 1000, 500, 250.0, 125.0).unwrap(),
            (600, 450)
        );
        assert!(image_point_to_screen(&frame, 1000, 500, 1000.0, 0.0).is_err());
    }

    #[test]
    fn outline_rects_follow_image_scaling() {
        let mut outline = json!({"rect":{"x":100,"y":50,"w":400,"h":200},"text":[{"rect":{"x":20,"y":10,"w":40,"h":20}}]});
        scale_outline_rects(&mut outline, 0.5, 0.25);
        assert_eq!(
            outline["rect"],
            json!({"x":50.0,"y":12.5,"w":200.0,"h":50.0})
        );
        assert_eq!(
            outline["text"][0]["rect"],
            json!({"x":10.0,"y":2.5,"w":20.0,"h":5.0})
        );
    }

    fn deliver(sink: RecordingSink, action: &str, params: Value) -> Result<Value, ProtocolError> {
        let geometry = ActionGeometry {
            frame: Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            },
            image_width: 100,
            image_height: 100,
        };
        deliver_physical(
            &Input::with_sink(sink),
            action,
            &params,
            7,
            (5, 5),
            &geometry,
        )
    }

    #[test]
    fn physical_stop_after_posting_is_unknown_with_delivered_units() {
        // `abc`: the first two characters (four events) post, then the target loses focus.
        let result = deliver(
            RecordingSink::default().refuse_admission_after(4),
            "typeText",
            json!({"text":"abc"}),
        )
        .unwrap();
        assert_eq!(result["outcome"], "unknown");
        assert_eq!(result["evidence"]["deliveredUnits"], 4);
        assert_eq!(result["evidence"]["windowId"], 7);
        assert_eq!(result["error"]["code"], "foreground_required");
        // setText: the click posts, then `a` of the select-all chord is refused and the
        // held control releases: motion, button down/up, control down/up.
        let result = deliver(
            RecordingSink::default().refuse_admission_after(5),
            "setText",
            json!({"text":"x"}),
        )
        .unwrap();
        assert_eq!(result["outcome"], "unknown");
        assert_eq!(result["evidence"]["deliveredUnits"], 5);
        // A drag point outside the look fails before anything posts.
        let error = deliver(
            RecordingSink::default(),
            "drag",
            json!({"path":[{"x":1,"y":1},{"x":500,"y":1}]}),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn an_unconfirmed_post_is_unknown_even_with_nothing_confirmed() {
        // The first press is applied but unacknowledged and its cleanup is rejected.
        let state = Arc::new(x11::InputState::default());
        let input = Input::with_state(
            RecordingSink::default().lose_ack(0, true).fail_post(1),
            Arc::clone(&state),
        );
        let geometry = ActionGeometry {
            frame: Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            },
            image_width: 100,
            image_height: 100,
        };
        let result = deliver_physical(
            &input,
            "keypress",
            &json!({"keys":["control"]}),
            7,
            (5, 5),
            &geometry,
        )
        .unwrap();
        assert_eq!(result["outcome"], "unknown");
        assert_eq!(result["evidence"]["deliveredUnits"], 0);
        assert_eq!(result["evidence"]["deliveryUncertain"], true);
        assert_eq!(
            result["evidence"]["unconfirmedReleases"],
            json!(["keycode 8"])
        );
        assert_eq!(result["error"]["code"], "internal_error");
        // The held key blocks the next action before it posts anything.
        let next = Input::with_state(RecordingSink::default(), state);
        let error = deliver_physical(
            &next,
            "typeText",
            &json!({"text":"a"}),
            7,
            (5, 5),
            &geometry,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InputUnsafe);
    }

    #[test]
    fn physical_refusal_before_any_post_stays_an_error() {
        for (action, params) in [
            ("press", json!({})),
            ("moveMouse", json!({})),
            ("scroll", json!({"scrollY":1})),
            ("drag", json!({"path":[{"x":1,"y":1},{"x":2,"y":2}]})),
            ("typeText", json!({"text":"a"})),
            ("setText", json!({"text":"a"})),
            ("keypress", json!({"keys":["enter"]})),
        ] {
            let refused = RecordingSink::default().refuse_admission_after(0);
            let error = deliver(refused, action, params.clone()).unwrap_err();
            assert_eq!(error.code, ErrorCode::ForegroundRequired, "{action}");
            let result = deliver(RecordingSink::default(), action, params).unwrap();
            assert_eq!(result["outcome"], "unknown", "{action}");
            assert!(result.get("error").is_none(), "{action}");
            assert!(
                result["evidence"].get("deliveredUnits").is_none(),
                "{action}"
            );
        }
        for (action, params) in [
            ("keypress", json!({})),
            ("drag", json!({})),
            ("drag", json!({"path":[{"y":1}]})),
            ("drag", json!({"path":[{"x":1}]})),
        ] {
            let error = deliver(RecordingSink::default(), action, params).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidRequest, "{action}");
        }
        let error = deliver(RecordingSink::default(), "wiggle", json!({})).unwrap_err();
        assert_eq!(error.code, ErrorCode::UnsupportedCommand);
    }

    /// An accessible whose children are `paths` on `:1.1`.
    struct Inventory(&'static [&'static str]);

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl Inventory {
        fn get_children(&self) -> Vec<(&str, OwnedObjectPath)> {
            self.0
                .iter()
                .map(|path| (":1.1", OwnedObjectPath::try_from(*path).unwrap()))
                .collect()
        }
    }

    /// A live root window named `Editor` as a readable frame.
    struct LiveWindow;

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl LiveWindow {
        #[zbus(property)]
        fn name(&self) -> &str {
            "Editor"
        }

        fn get_role(&self) -> u32 {
            23
        }
    }

    /// Live screen extents the test moves; `None` fails the read.
    struct LiveExtents(Arc<Mutex<Option<Rect>>>);

    #[zbus::interface(name = "org.a11y.atspi.Component")]
    impl LiveExtents {
        fn get_extents(&self, _coordinate_type: u32) -> zbus::fdo::Result<(i32, i32, i32, i32)> {
            let frame = self.0.lock().unwrap().clone();
            frame
                .map(|frame| (frame.x, frame.y, frame.width, frame.height))
                .ok_or_else(|| zbus::fdo::Error::Failed("extents unavailable".into()))
        }
    }

    /// A bus daemon reporting PID 42 for every connection.
    struct OwnerPid;

    #[zbus::interface(name = "org.freedesktop.DBus")]
    impl OwnerPid {
        #[zbus(name = "GetConnectionUnixProcessID")]
        fn get_connection_unix_process_id(&self, _name: &str) -> u32 {
            42
        }
    }

    /// An X11 enrichment with `deadline` and its own listing slot, apart from the helper's.
    fn enrichment(deadline: Duration) -> &'static Enrichment {
        Box::leak(Box::new(Enrichment {
            deadline,
            slot: Box::leak(Box::new(Semaphore::new(1))),
        }))
    }

    /// An `Editor` window of PID 42 at `frame` with class `class`.
    fn editor_window(id: u32, frame: &Rect, class: &str) -> x11::WindowInfo {
        x11::WindowInfo {
            id,
            pid: 42,
            title: "Editor".into(),
            wm_class: Some((class.to_lowercase(), class.into())),
            frame: frame.clone(),
            focused: false,
            minimized: false,
            z_order: 0,
        }
    }

    #[tokio::test]
    async fn look_root_follows_the_look_not_a_reissued_inventory_handle() {
        let state = Arc::new(Mutex::new(HelperState::default()));
        let mut other = observed_root();
        other.pid = 43;
        other.accessible.path = "/other".into();
        let mut closed = observed_root();
        closed.accessible.path = "/closed".into();
        // A is listed and observed, then a PID-scoped listing of B drops A's handle.
        let a_ref = lock(&state).unwrap().replace_roots(vec![observed_root()])[0]
            .0
            .clone();
        // The look saved its X11-enriched frame, title and class: none is carried over or
        // ranked against, only the root's live metadata is.
        let saved = observed_root().frame.unwrap();
        let moved = Rect {
            x: 600,
            ..saved.clone()
        };
        let mut looked = observed_root();
        looked.wm_class = Some(("stale".into(), "Stale".into()));
        let (look_id, _) = lock(&state)
            .unwrap()
            .insert_look(looked, vec![node()], None);
        let (closed_look, _) = lock(&state).unwrap().insert_look(closed, vec![], None);
        lock(&state).unwrap().replace_roots(vec![other]);
        assert!(lock(&state).unwrap().root(&a_ref).is_none());
        let extents = Arc::new(Mutex::new(Some(saved.clone())));
        with_peer(
            |server| {
                server
                    .serve_at("/org/freedesktop/DBus", OwnerPid)?
                    .serve_at("/org/a11y/atspi/accessible/root", Inventory(&["/app"]))?
                    .serve_at("/app", Inventory(&["/window"]))?
                    .serve_at("/window", LiveWindow)?
                    .serve_at("/window", LiveExtents(Arc::clone(&extents)))
            },
            async |connection| {
                let connect = async || {
                    Ok(AtspiClient::from_connection(
                        connection.clone(),
                        Duration::from_millis(250),
                    ))
                };
                let args = json!({ "lookId": look_id });
                let lookup = async |windows: Vec<x11::WindowInfo>| {
                    look_root(
                        &state,
                        &args,
                        connect,
                        move || Ok(Some(windows)),
                        enrichment(X11_ENRICHMENT.deadline),
                    )
                    .await
                    .unwrap()["root"]
                        .clone()
                };
                let class = |root: &Value| root["metadata"]["wmClass"]["class"].clone();

                // Unchanged inventory: the listing and the look's lookup pair the same window.
                let unchanged = vec![
                    editor_window(71, &saved, "Fixture"),
                    editor_window(72, &moved, "Other"),
                ];
                let mut listed = [observed_root()];
                listed[0].frame = Some(saved.clone());
                listed[0].x11_window = None;
                x11::enrich_roots(&mut listed, &unchanged);
                let root = lookup(unchanged).await;
                assert_eq!(listed[0].x11_window, Some(71));
                assert_eq!(root["windowId"], 71);
                assert_eq!(class(&root), "Fixture");
                assert_eq!(root["metadata"]["x11Pairing"], "paired");
                assert_eq!(root["pid"], 42);
                assert_eq!(root["metadata"]["busName"], ":1.1");
                assert_eq!(root["metadata"]["objectPath"], "/window");
                // No inventory handle names it any more; the look still does.
                assert_eq!(root["rootRef"], "");

                // The same-title siblings swapped places and the root's own window gained a
                // blocked class: the live extents pair it, never the sibling at the saved frame.
                *extents.lock().unwrap() = Some(moved.clone());
                let swapped = vec![
                    editor_window(71, &moved, "KeePassXC"),
                    editor_window(72, &saved, "Fixture"),
                ];
                let root = lookup(swapped.clone()).await;
                assert_eq!(root["windowId"], 71);
                assert_eq!(class(&root), "KeePassXC");
                assert_eq!(root["framePoints"]["x"], 600);

                // Extreme live extents rank in i64: the closer blocked-class window still
                // pairs, never the farther allowed one an overflowing distance would pick.
                let at = |x| Rect { x, ..saved.clone() };
                for (live, near, far) in [(i32::MIN, -1, 0), (i32::MAX, 0, -1)] {
                    *extents.lock().unwrap() = Some(at(live));
                    let root = lookup(vec![
                        editor_window(81, &at(far), "Fixture"),
                        editor_window(82, &at(near), "KeePassXC"),
                    ])
                    .await;
                    assert_eq!(root["windowId"], 82, "{live}");
                    assert_eq!(class(&root), "KeePassXC", "{live}");
                    assert_eq!(root["metadata"]["x11Pairing"], "paired", "{live}");
                }

                // Without live extents the same-title siblings tie: no class is attributed,
                // and every tied class is a block-only alias, so the blocked one still refuses.
                *extents.lock().unwrap() = None;
                let root = lookup(swapped.clone()).await;
                assert!(root["metadata"]["wmClass"].is_null());
                assert_eq!(root["metadata"]["x11Pairing"], "ambiguous");
                assert_eq!(
                    root["blockAliases"],
                    json!(["keepassxc", "KeePassXC", "fixture", "Fixture"])
                );
                // A tie of classless windows has no aliases at all, and is still ambiguous.
                let classless = swapped
                    .iter()
                    .cloned()
                    .map(|window| x11::WindowInfo {
                        wm_class: None,
                        ..window
                    })
                    .collect();
                let root = lookup(classless).await;
                assert_eq!(root["metadata"]["x11Pairing"], "ambiguous");
                assert_eq!(root["blockAliases"], json!([]));
                // No same-PID window: unpaired, and no stale window id survives.
                let root = lookup(vec![]).await;
                assert_eq!(root["metadata"]["x11Pairing"], "unpaired");
                assert!(root["windowId"].is_null());

                // Without an X display no class evidence exists: confirmed absence.
                let found = look_root(
                    &state,
                    &args,
                    connect,
                    || Ok(None),
                    enrichment(X11_ENRICHMENT.deadline),
                )
                .await
                .unwrap();
                assert!(found["root"]["metadata"]["wmClass"].is_null());
                assert_eq!(found["root"]["metadata"]["x11Pairing"], "absent");
                assert_eq!(found["root"]["pid"], 42);
                // An X display that cannot be listed is missing evidence, never absence.
                let found = look_root(
                    &state,
                    &args,
                    connect,
                    || Err(capability("X11 unavailable: connection refused")),
                    enrichment(X11_ENRICHMENT.deadline),
                )
                .await
                .unwrap();
                assert!(found["root"]["metadata"]["wmClass"].is_null());
                assert_eq!(found["root"]["metadata"]["x11Pairing"], "unavailable");
                assert_eq!(found["root"]["pid"], 42);

                // A stalled X11 listing never holds the reply: the membership result comes
                // back past the enrichment deadline marked `unavailable`, never as a clean
                // check, though the stalled window's class would have blocked it.
                let (release, stalled) = std::sync::mpsc::channel::<()>();
                let started = Instant::now();
                let found = look_root(
                    &state,
                    &args,
                    connect,
                    move || {
                        let _ = stalled.recv_timeout(Duration::from_secs(5));
                        Ok(Some(vec![editor_window(71, &saved, "KeePassXC")]))
                    },
                    enrichment(Duration::from_millis(50)),
                )
                .await
                .unwrap();
                assert!(started.elapsed() < Duration::from_secs(2));
                assert_eq!(found["root"]["metadata"]["x11Pairing"], "unavailable");
                assert!(found["root"]["metadata"]["wmClass"].is_null());
                assert_eq!(found["root"]["pid"], 42);
                drop(release);

                // One listing at a time: while one is stuck, a later lookup spawns no thread
                // (its listing never runs) and is `unavailable` at once. The slot frees only
                // once the stuck listing itself returns.
                let single = enrichment(Duration::from_millis(50));
                let (release, stuck) = std::sync::mpsc::channel::<()>();
                let found = look_root(
                    &state,
                    &args,
                    connect,
                    move || {
                        let _ = stuck.recv();
                        Ok(None)
                    },
                    single,
                )
                .await
                .unwrap();
                assert_eq!(found["root"]["metadata"]["x11Pairing"], "unavailable");
                let spawned = Arc::new(AtomicUsize::new(0));
                let counted = || {
                    let spawned = Arc::clone(&spawned);
                    move || {
                        spawned.fetch_add(1, Ordering::SeqCst);
                        Ok(None)
                    }
                };
                for _ in 0..3 {
                    let found = look_root(&state, &args, connect, counted(), single)
                        .await
                        .unwrap();
                    assert_eq!(found["root"]["metadata"]["x11Pairing"], "unavailable");
                }
                assert_eq!(spawned.load(Ordering::SeqCst), 0);
                assert_eq!(single.slot.available_permits(), 0);
                drop(release);
                let freed = Instant::now();
                while single.slot.available_permits() == 0 {
                    assert!(freed.elapsed() < Duration::from_secs(5), "slot never freed");
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                let found = look_root(&state, &args, connect, counted(), single)
                    .await
                    .unwrap();
                assert_eq!(found["root"]["metadata"]["x11Pairing"], "absent");
                assert_eq!(spawned.load(Ordering::SeqCst), 1);

                // Its application no longer lists the closed root: proven absent.
                let reply = peer_request(
                    &state,
                    &connection,
                    "atspiLookRoot",
                    json!({ "lookId": closed_look }),
                )
                .await;
                assert_eq!(reply.result.unwrap(), json!({ "root": null }));
                for (args, code) in [
                    (json!({}), ErrorCode::InvalidRequest),
                    (json!({"lookId":"look_999"}), ErrorCode::StaleLook),
                ] {
                    let reply = peer_request(&state, &connection, "atspiLookRoot", args).await;
                    assert_eq!(reply.error.unwrap().code, code);
                }
            },
        )
        .await;
    }

    #[tokio::test]
    async fn list_roots_reports_x11_class_evidence_per_root() {
        let state = Arc::new(Mutex::new(HelperState::default()));
        let frame = observed_root().frame.unwrap();
        let extents = Arc::new(Mutex::new(Some(frame.clone())));
        with_peer(
            |server| {
                server
                    .serve_at("/org/freedesktop/DBus", OwnerPid)?
                    .serve_at("/org/a11y/atspi/accessible/root", Inventory(&["/app"]))?
                    .serve_at("/app", Inventory(&["/window"]))?
                    .serve_at("/window", LiveWindow)?
                    .serve_at("/window", LiveExtents(Arc::clone(&extents)))
            },
            async |connection| {
                let connect = async || {
                    Ok(AtspiClient::from_connection(
                        connection.clone(),
                        Duration::from_millis(250),
                    ))
                };
                type Windows =
                    Box<dyn FnOnce() -> Result<Option<Vec<x11::WindowInfo>>, ProtocolError> + Send>;
                let list = async |windows: Windows, enrichment: &'static Enrichment| {
                    let listed = list_roots_with(&state, &json!({}), connect, windows, enrichment)
                        .await
                        .unwrap();
                    assert_eq!(listed["roots"].as_array().unwrap().len(), 1);
                    listed["roots"][0].clone()
                };
                let ample = enrichment(X11_ENRICHMENT.deadline);
                let blocked = move || Ok(Some(vec![editor_window(71, &frame, "KeePassXC")]));

                // A completed listing pairs the window: its class is evidence.
                let root = list(Box::new(blocked.clone()), ample).await;
                assert_eq!(root["metadata"]["x11Pairing"], "paired");
                assert_eq!(root["metadata"]["wmClass"]["class"], "KeePassXC");
                assert_eq!(root["windowId"], 71);
                let root = list(Box::new(|| Ok(Some(vec![]))), ample).await;
                assert_eq!(root["metadata"]["x11Pairing"], "unpaired");
                // No X display: confirmed absence of class evidence.
                let root = list(Box::new(|| Ok(None)), ample).await;
                assert_eq!(root["metadata"]["x11Pairing"], "absent");
                // A configured display that cannot be listed is missing evidence, never absence.
                let root = list(
                    Box::new(|| Err(capability("X11 unavailable: connection refused"))),
                    ample,
                )
                .await;
                assert_eq!(root["metadata"]["x11Pairing"], "unavailable");
                assert!(root["metadata"]["wmClass"].is_null());

                // A stalled listing whose window has a blocked class never holds the reply,
                // and never reads as a clean check (#1311): discovery replies while the
                // stalled read still holds the listing slot.
                let (release, stalled) = std::sync::mpsc::channel::<()>();
                let stalling = enrichment(Duration::from_millis(50));
                let root = list(
                    Box::new(move || {
                        // A hang guard only: the reply must come while this read still blocks.
                        let _ = stalled.recv_timeout(Duration::from_secs(60));
                        blocked()
                    }),
                    stalling,
                )
                .await;
                assert_eq!(stalling.slot.available_permits(), 0);
                assert_eq!(root["metadata"]["x11Pairing"], "unavailable");
                assert!(root["metadata"]["wmClass"].is_null());
                assert_eq!(root["blockAliases"], json!([]));
                drop(release);
                slot_freed(stalling);

                // Discovery shares the look-root listing slot: while that listing is stuck, a
                // listing spawns no thread and reports `unavailable`.
                let shared = enrichment(Duration::from_millis(50));
                let (release, stuck) = std::sync::mpsc::channel::<()>();
                lock(&state).unwrap().replace_roots(vec![observed_root()]);
                let (look_id, _) =
                    lock(&state)
                        .unwrap()
                        .insert_look(observed_root(), vec![node()], None);
                let found = look_root(
                    &state,
                    &json!({ "lookId": look_id }),
                    connect,
                    move || {
                        let _ = stuck.recv();
                        Ok(None)
                    },
                    shared,
                )
                .await
                .unwrap();
                assert_eq!(found["root"]["metadata"]["x11Pairing"], "unavailable");
                let spawned = Arc::new(AtomicUsize::new(0));
                let counted = Arc::clone(&spawned);
                let root = list(
                    Box::new(move || {
                        counted.fetch_add(1, Ordering::SeqCst);
                        Ok(None)
                    }),
                    shared,
                )
                .await;
                assert_eq!(root["metadata"]["x11Pairing"], "unavailable");
                assert_eq!(spawned.load(Ordering::SeqCst), 0);
                drop(release);
            },
        )
        .await;
    }

    #[tokio::test]
    async fn list_roots_lists_several_pids_with_one_x11_listing() {
        let state = Arc::new(Mutex::new(HelperState::default()));
        let frame = observed_root().frame.unwrap();
        let extents = Arc::new(Mutex::new(Some(frame)));
        for pids in [json!([]), json!([42, "7"]), json!(42)] {
            let error = list_roots_with(
                &state,
                &json!({ "pids": pids }),
                no_bus,
                || Ok(None),
                enrichment(X11_ENRICHMENT.deadline),
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidRequest, "{pids}");
        }
        with_peer(
            |server| {
                server
                    .serve_at("/org/freedesktop/DBus", OwnerPid)?
                    .serve_at("/org/a11y/atspi/accessible/root", Inventory(&["/app"]))?
                    .serve_at("/app", Inventory(&["/window"]))?
                    .serve_at("/window", LiveWindow)?
                    .serve_at("/window", LiveExtents(Arc::clone(&extents)))
            },
            async |connection| {
                let connect = async || {
                    Ok(AtspiClient::from_connection(
                        connection.clone(),
                        Duration::from_millis(250),
                    ))
                };
                let listings = Arc::new(AtomicUsize::new(0));
                for (args, found) in [
                    (json!({ "pids": [7, 42] }), 1),
                    (json!({ "pids": [7, 8] }), 0),
                    (json!({ "pid": 42 }), 1),
                    (json!({ "pid": 7 }), 0),
                ] {
                    let counted = Arc::clone(&listings);
                    let listed = list_roots_with(
                        &state,
                        &args,
                        connect,
                        move || {
                            counted.fetch_add(1, Ordering::SeqCst);
                            Ok(None)
                        },
                        enrichment(X11_ENRICHMENT.deadline),
                    )
                    .await
                    .unwrap();
                    assert_eq!(listed["roots"].as_array().unwrap().len(), found, "{args}");
                }
                // One X11 listing per request, however many processes it names.
                assert_eq!(listings.load(Ordering::SeqCst), 4);
            },
        )
        .await;
    }

    #[tokio::test]
    async fn concurrent_x11_listings_take_turns_rather_than_fail() {
        // One listing per app: the second waits for the slot within its deadline, then runs.
        let slot = enrichment(Duration::from_secs(5));
        let (release, held) = std::sync::mpsc::channel::<()>();
        let (first, second, ()) = tokio::join!(
            bounded(slot, move || held.recv().map(|()| 1)),
            bounded(slot, || Ok::<_, std::sync::mpsc::RecvError>(2)),
            async { release.send(()).unwrap() },
        );
        assert_eq!((first, second), (Some(Ok(1)), Some(Ok(2))));
        slot_freed(slot);
    }

    /// Wait for `enrichment`'s listing thread to release its slot, which it does after its
    /// reply is sent.
    fn slot_freed(enrichment: &Enrichment) {
        let started = Instant::now();
        while enrichment.slot.available_permits() == 0 {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "slot never freed"
            );
            std::thread::yield_now();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn bounded_rejects_late_ready_result() {
        // Polled by hand: the task is resumed only once its deadline and its permit or
        // reply are both ready, and a timer polls its future first.
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        let past = Duration::from_millis(51);

        // The reply arrives in time but is read past the deadline: refused.
        let slot = enrichment(Duration::from_millis(50));
        let (release, held) = std::sync::mpsc::channel::<()>();
        let mut late = std::pin::pin!(bounded(slot, move || held.recv().map(|()| 7)));
        assert!(late.as_mut().poll(&mut cx).is_pending());
        release.send(()).unwrap();
        slot_freed(slot);
        tokio::time::advance(past).await;
        assert_eq!(late.as_mut().poll(&mut cx), std::task::Poll::Ready(None));

        // A queued request whose permit frees after its deadline spawns no listing.
        let slot = enrichment(Duration::from_millis(50));
        let busy = slot.slot.try_acquire().unwrap();
        let spawned = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&spawned);
        let mut queued = std::pin::pin!(bounded(slot, move || {
            counted.fetch_add(1, Ordering::SeqCst);
        }));
        assert!(queued.as_mut().poll(&mut cx).is_pending());
        tokio::time::advance(past).await;
        drop(busy);
        assert_eq!(queued.as_mut().poll(&mut cx), std::task::Poll::Ready(None));
        slot_freed(slot);
        assert_eq!(spawned.load(Ordering::SeqCst), 0);
    }

    /// A bus connector for requests that must be refused before reaching AT-SPI.
    async fn no_bus() -> Result<AtspiClient, ProtocolError> {
        panic!("connected to AT-SPI before refusing")
    }

    #[tokio::test]
    async fn strict_headless_refuses_physical_fallback_in_every_session_kind() {
        // An X11 root, and one with no X11 window (Wayland or no graphical session).
        let mut detached = observed_root();
        detached.accessible.path = "/detached".into();
        detached.x11_window = None;
        detached.frame = None;
        for root in [observed_root(), detached] {
            let state = Arc::new(Mutex::new(HelperState::default()));
            let root_ref = lock(&state).unwrap().replace_roots(vec![root.clone()])[0]
                .0
                .clone();
            let (look_id, nodes) = lock(&state).unwrap().insert_look(root, vec![node()], None);
            let element = json!({"ref": nodes[0].reference});
            with_peer(Ok, async |connection| {
                for (cmd, args) in [
                    // The element has no Action interface, so press falls back.
                    ("act", json!({"action":"press","target":element})),
                    (
                        "act",
                        json!({"action":"scroll","target":element,"params":{"scrollY":1}}),
                    ),
                    ("act", json!({"action":"click","target":{"x":1,"y":1}})),
                    ("focusWindow", json!({"rootRef":root_ref})),
                ] {
                    let mut args = args;
                    args["lookId"] = json!(look_id);
                    args["policy"] = json!("ax_only");
                    let error = peer_request(&state, &connection, cmd, args.clone())
                        .await
                        .error
                        .unwrap();
                    assert_eq!(error.code, ErrorCode::ForegroundRequired, "{args}");
                }
            })
            .await;
        }

        // Unknown handles and no bus: physical-only delivery is refused before any target
        // lookup or bus connection, so the refusal says nothing about either (#1298).
        let state = Arc::new(Mutex::new(HelperState::default()));
        let unknown = "linux:look_999:@e1";
        let physical_only = [
            json!({"action":"click","target":{"x":1,"y":1}}),
            json!({"action":"scroll","target":{"ref":unknown},"params":{"scrollY":1}}),
            json!({"action":"keypress","target":{"ref":unknown},"params":{"keys":["a"]}}),
        ];
        for mut args in physical_only.clone() {
            args["lookId"] = json!("look_999");
            args["policy"] = json!("ax_only");
            let error = act(&state, &args, no_bus, |_, _, _, _, _, _| {
                panic!("attempted physical input")
            })
            .await
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::ForegroundRequired, "{args}");
        }
        let error = focus_window(&state, &json!({"rootRef":"@w999","policy":"ax_only"}))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ForegroundRequired);
        // Batch steps take the same path.
        let steps = physical_only
            .iter()
            .map(|step| {
                let mut step = step.clone();
                step["lookId"] = json!("look_999");
                step["policy"] = json!("ax_only");
                step
            })
            .collect::<Vec<_>>();
        let reply = handle_request_with(
            &state,
            &Request {
                protocol_version: PROTOCOL_VERSION,
                id: "batch".into(),
                cmd: "actBatch".into(),
                args: json!({ "actions": steps }),
            },
            &InputState::default(),
            no_bus,
            |_, _, _, _, _, _| panic!("attempted physical input"),
        )
        .await
        .result
        .unwrap();
        assert_eq!(reply["steps"][0]["error"]["code"], "foreground_required");
        // Request shape is still checked first, and an action an AT-SPI element can take
        // semantically still resolves its target to try that first.
        for (args, code) in [
            (
                json!({"lookId":"look_999","action":"click","target":{"x":1},"policy":"ax_only"}),
                ErrorCode::InvalidRequest,
            ),
            (
                json!({"lookId":"look_999","action":"press","target":{"ref":unknown},"policy":"ax_only"}),
                ErrorCode::StaleLook,
            ),
        ] {
            let error = act(&state, &args, no_bus, |_, _, _, _, _, _| {
                panic!("attempted physical input")
            })
            .await
            .unwrap_err();
            assert_eq!(error.code, code, "{args}");
        }
    }

    #[tokio::test]
    async fn a_partially_delivered_step_stops_the_batch_as_unknown() {
        let batch = json!({"actions":[{"lookId":"one","value":0},{"lookId":"one","value":1},{"lookId":"one","value":2}]});
        let result = act_batch_with(
            &batch,
            || false,
            |action| {
                std::future::ready(match action["value"].as_u64().unwrap() {
                    0 => Ok(json!({"outcome":"worked"})),
                    1 => Ok(json!({
                        "outcome":"unknown",
                        "evidence":{"deliveredUnits":3},
                        "error":{"code":"foreground_required","message":"focus moved"}
                    })),
                    _ => panic!("ran an action after a partial delivery"),
                })
            },
        )
        .await
        .unwrap();
        assert_eq!(result["outcome"], "unknown");
        assert_eq!(result["stoppedAt"], 1);
        assert_eq!(result["steps"][1]["evidence"]["deliveredUnits"], 3);
    }

    #[test]
    fn batch_outcome_preserves_unknown_physical_results() {
        assert_eq!(
            batch_outcome(&[json!({"outcome":"worked"})], false),
            "worked"
        );
        assert_eq!(
            batch_outcome(
                &[json!({"outcome":"worked"}), json!({"outcome":"unknown"})],
                false
            ),
            "unknown"
        );
        assert_eq!(
            batch_outcome(&[json!({"outcome":"unknown"})], true),
            "unknown"
        );
        for prefix in ["worked", "unknown"] {
            assert_eq!(
                batch_outcome(
                    &[json!({"outcome":prefix}), json!({"outcome":"didnt"})],
                    true
                ),
                "unknown",
                "{prefix} prefix"
            );
        }
        assert_eq!(batch_outcome(&[json!({"outcome":"didnt"})], true), "didnt");
    }
}
