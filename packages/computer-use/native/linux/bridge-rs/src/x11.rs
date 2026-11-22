//! X11/EWMH enrichment, capture, focus, and guarded XTEST physical input.
use crate::atspi::{Rect, RootSnapshot};
use crate::{ErrorCode, ProtocolError};
use base64::Engine as _;
use serde_json::{json, Value};
use std::cell::Cell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::errors::ReplyError;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ButtonIndex, ClientMessageData, ClientMessageEvent, ConnectionExt as _,
    Drawable, EventMask, GetImageReply, ImageFormat, ImageOrder, Keycode, MapState, Window,
    BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, CLIENT_MESSAGE_EVENT, KEY_PRESS_EVENT,
    KEY_RELEASE_EVENT, MOTION_NOTIFY_EVENT,
};
use x11rb::protocol::{composite, xtest};
use x11rb::rust_connection::RustConnection;

const MAX_CAPTURE_PIXELS: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKind {
    X11,
    Wayland,
    Headless,
}
impl SessionKind {
    pub fn detect() -> Self {
        let kind = std::env::var("XDG_SESSION_TYPE")
            .unwrap_or_default()
            .to_ascii_lowercase();
        if kind == "wayland" || (kind.is_empty() && std::env::var_os("WAYLAND_DISPLAY").is_some()) {
            Self::Wayland
        } else if kind == "x11" || std::env::var_os("DISPLAY").is_some() {
            Self::X11
        } else {
            Self::Headless
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::X11 => "x11",
            Self::Wayland => "wayland",
            Self::Headless => "headless",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhysicalPolicy {
    AxOnly,
    Background,
    Default,
    Foreground,
}
impl PhysicalPolicy {
    pub fn parse(value: Option<&str>) -> Result<Self, ProtocolError> {
        match value.unwrap_or("default") {
            "ax_only" => Ok(Self::AxOnly),
            "background" => Ok(Self::Background),
            "default" => Ok(Self::Default),
            "foreground" => Ok(Self::Foreground),
            value => Err(invalid(format!("Unknown delivery policy '{value}'"))),
        }
    }
    /// Refuse strict headless (`ax_only`) with `foreground_required` before any physical
    /// target, geometry or session is resolved (#1298): the action needs foreground
    /// delivery, whatever this session could otherwise offer.
    pub fn refuse_strict_headless(self) -> Result<(), ProtocolError> {
        if self == Self::AxOnly {
            return Err(err(
                "ax_only policy forbids synthesized input and window focus",
                ErrorCode::ForegroundRequired,
            ));
        }
        Ok(())
    }
    /// Admit physical input under this policy in `session`; strict headless refuses first.
    pub fn require_physical(self, session: SessionKind) -> Result<(), ProtocolError> {
        self.refuse_strict_headless()?;
        if session == SessionKind::Headless {
            return Err(err(
                "Physical input is unavailable in a headless Linux session",
                ErrorCode::CoordinateBlocked,
            ));
        }
        if session != SessionKind::X11 {
            return Err(err(
                "XTEST is unavailable in native Wayland sessions; use AT-SPI",
                ErrorCode::CapabilityDeferred,
            ));
        }
        if self == Self::Background {
            return Err(err(
                "Background policy forbids global XTEST input",
                ErrorCode::ForegroundRequired,
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    pub id: u32,
    pub pid: u64,
    pub title: String,
    /// `WM_CLASS` (instance, class), app-supplied.
    pub wm_class: Option<(String, String)>,
    pub frame: Rect,
    pub focused: bool,
    pub minimized: bool,
    pub z_order: usize,
}
pub struct Capture {
    pub png_base64: String,
    pub width: u16,
    pub height: u16,
    pub source: &'static str,
    pub warnings: Vec<String>,
}
pub fn available() -> bool {
    SessionKind::detect() == SessionKind::X11 && connect().is_ok()
}

pub fn list_windows() -> Result<Vec<WindowInfo>, ProtocolError> {
    let (conn, screen) = connect()?;
    let root = conn.setup().roots[screen].root;
    let a = Atoms::new(&conn)?;
    let active = property32(&conn, root, a.active, AtomEnum::WINDOW.into())
        .first()
        .copied();
    let mut windows = property32(&conn, root, a.stacking, AtomEnum::WINDOW.into());
    if windows.is_empty() {
        windows = property32(&conn, root, a.clients, AtomEnum::WINDOW.into());
    }
    let mut out = Vec::new();
    for (z_order, id) in windows.into_iter().rev().enumerate() {
        let Ok(g) = conn
            .get_geometry(id)
            .ok()
            .and_then(|c| c.reply().ok())
            .ok_or(())
        else {
            continue;
        };
        let translated = conn
            .translate_coordinates(id, root, 0, 0)
            .ok()
            .and_then(|c| c.reply().ok());
        let states = property32(&conn, id, a.state, AtomEnum::ATOM.into());
        out.push(WindowInfo {
            id,
            pid: property32(&conn, id, a.pid, AtomEnum::CARDINAL.into())
                .first()
                .copied()
                .unwrap_or(0) as u64,
            title: title(&conn, id, &a),
            wm_class: conn
                .get_property(false, id, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 1024)
                .ok()
                .and_then(|cookie| cookie.reply().ok())
                .and_then(|reply| wm_class_property(reply.format, reply.bytes_after, &reply.value)),
            frame: Rect {
                x: translated
                    .as_ref()
                    .map(|r| i32::from(r.dst_x))
                    .unwrap_or(i32::from(g.x)),
                y: translated
                    .as_ref()
                    .map(|r| i32::from(r.dst_y))
                    .unwrap_or(i32::from(g.y)),
                width: i32::from(g.width),
                height: i32::from(g.height),
            },
            focused: active == Some(id),
            minimized: states.contains(&a.hidden),
            z_order,
        });
    }
    Ok(out)
}

/// Pair each root with its best-ranked X11 window of the same PID, title first, then
/// geometry; each window pairs once. Pairing is a heuristic, so `WM_CLASS` is copied only
/// when no other window of that PID ranks equally (#1300): a tie is no class evidence,
/// never proof that one sibling's class belongs to the root. Blocking is additive, so a tie
/// reports every tied window's class in `class_candidates` and any blocked one refuses it.
pub fn enrich_roots(roots: &mut [RootSnapshot], windows: &[WindowInfo]) {
    let mut used = Vec::new();
    for root in roots {
        let rank = |w: &WindowInfo| {
            let title = if !root.name.is_empty()
                && (w.title.contains(&root.name) || root.name.contains(&w.title))
            {
                0
            } else {
                1_000_000
            };
            title + distance(root.frame.as_ref(), &w.frame)
        };
        let owned = || windows.iter().filter(|w| w.pid != 0 && w.pid == root.pid);
        let best = owned()
            .filter(|w| !used.contains(&w.id))
            .min_by_key(|w| rank(w));
        if let Some(w) = best {
            // A window already paired elsewhere still ties: that pairing was a choice too.
            let tied = owned()
                .filter(|other| rank(other) == rank(w))
                .collect::<Vec<_>>();
            let ambiguous = tied.len() > 1;
            root.class_candidates = if ambiguous {
                tied.iter()
                    .filter_map(|other| other.wm_class.clone())
                    .collect()
            } else {
                Vec::new()
            };
            used.push(w.id);
            root.x11_window = Some(w.id);
            root.frame = Some(w.frame.clone());
            root.is_focused = w.focused;
            root.is_minimized = w.minimized;
            root.z_order = Some(w.z_order);
            root.wm_class = if ambiguous { None } else { w.wm_class.clone() };
            if root.name.is_empty() {
                root.name.clone_from(&w.title);
            }
        }
    }
}
/// Parse a `WM_CLASS` property reply: only a complete 8-bit value, never a truncated or
/// differently formatted one.
pub fn wm_class_property(format: u8, bytes_after: u32, value: &[u8]) -> Option<(String, String)> {
    (format == 8 && bytes_after == 0)
        .then(|| parse_wm_class(value))
        .flatten()
}
/// Parse an ICCCM `WM_CLASS` value: two NUL-terminated Latin-1 strings, instance then class.
/// Anything else is unattributed rather than guessed.
pub fn parse_wm_class(value: &[u8]) -> Option<(String, String)> {
    let value = value.strip_suffix(&[0])?;
    let mut parts = value.split(|&byte| byte == 0);
    let latin1 = |bytes: &[u8]| {
        bytes
            .iter()
            .map(|&byte| char::from(byte))
            .collect::<String>()
    };
    let (instance, class) = (parts.next()?, parts.next()?);
    (parts.next().is_none() && !class.is_empty()).then(|| (latin1(instance), latin1(class)))
}
fn distance(a: Option<&Rect>, b: &Rect) -> i64 {
    a.map(|a| {
        i64::from(
            (a.x - b.x).abs()
                + (a.y - b.y).abs()
                + (a.width - b.width).abs()
                + (a.height - b.height).abs(),
        )
    })
    .unwrap_or(0)
}

pub fn focus_window(window: Window, policy: PhysicalPolicy) -> Result<Value, ProtocolError> {
    policy.require_physical(SessionKind::detect())?;
    activate_unless_cancelled(
        &InputState::shared(),
        || {
            let (conn, screen) = connect()?;
            let root = conn.setup().roots[screen].root;
            let atom = intern(&conn, "_NET_ACTIVE_WINDOW")?;
            Ok((conn, root, atom))
        },
        |(conn, root, atom)| send_active_window(&conn, root, window, atom),
    )?;
    Ok(json!({"focused":true,"delivery":"ewmh","windowId":window}))
}

/// Run the blocking preparation for an EWMH activation request, e.g. X11 connection
/// setup and the atom lookup, then send it with `send` unless shutdown began in the
/// meantime: admission before `prepare` does not cover a request sent after it.
fn activate_unless_cancelled<P>(
    state: &InputState,
    prepare: impl FnOnce() -> Result<P, ProtocolError>,
    send: impl FnOnce(P) -> Result<(), ProtocolError>,
) -> Result<(), ProtocolError> {
    let prepared = prepare()?;
    if state.is_cancelled() {
        return Err(err(
            "Helper is shutting down; the focus request was not sent",
            ErrorCode::Cancelled,
        ));
    }
    send(prepared)
}

/// Ask the window manager to activate `target` with `_NET_ACTIVE_WINDOW` (`atom`).
fn send_active_window(
    c: &RustConnection,
    root: Window,
    target: Window,
    atom: Atom,
) -> Result<(), ProtocolError> {
    let event = ClientMessageEvent {
        response_type: CLIENT_MESSAGE_EVENT,
        format: 32,
        sequence: 0,
        window: target,
        type_: atom,
        data: ClientMessageData::from([2, 0, 0, 0, 0]),
    };
    c.send_event(
        false,
        root,
        EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
        event,
    )
    .map_err(xerr)?
    .check()
    .map_err(xerr)?;
    c.flush().map_err(xerr)
}

pub fn capture_window(
    window: Window,
    max_dimension: Option<u32>,
) -> Result<Capture, ProtocolError> {
    let (conn, _) = connect()?;
    capture_with(&conn, window, max_dimension)
}

/// X11 round trips needed by the capture policy and encoder.
trait CaptureSource {
    fn dimensions(&self, window: Window) -> Result<(u16, u16), ProtocolError>;
    fn name_pixmap(&self, window: Window) -> Result<Option<Drawable>, ProtocolError>;
    fn read_image(
        &self,
        drawable: Drawable,
        width: u16,
        height: u16,
    ) -> Result<GetImageReply, ProtocolError>;
    fn release_pixmap(&self, pixmap: Drawable);
    fn image_order(&self) -> ImageOrder;
}

impl CaptureSource for RustConnection {
    fn dimensions(&self, window: Window) -> Result<(u16, u16), ProtocolError> {
        let g = self
            .get_geometry(window)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?;
        Ok((g.width, g.height))
    }

    fn name_pixmap(&self, window: Window) -> Result<Option<Drawable>, ProtocolError> {
        let pixmap = self.generate_id().map_err(xerr)?;
        Ok(composite::name_window_pixmap(self, window, pixmap)
            .ok()
            .and_then(|cookie| cookie.check().ok())
            .map(|()| pixmap))
    }

    fn read_image(
        &self,
        drawable: Drawable,
        width: u16,
        height: u16,
    ) -> Result<GetImageReply, ProtocolError> {
        self.get_image(
            ImageFormat::Z_PIXMAP,
            drawable,
            0,
            0,
            width,
            height,
            u32::MAX,
        )
        .map_err(xerr)?
        .reply()
        .map_err(|e| {
            err(
                format!("X11 GetImage failed: {e}"),
                ErrorCode::CaptureFailed,
            )
        })
    }

    fn release_pixmap(&self, pixmap: Drawable) {
        let _ = self.free_pixmap(pixmap);
    }

    fn image_order(&self) -> ImageOrder {
        self.setup().image_byte_order
    }
}

/// Choose the drawable and encode a bounded PNG without depending on a live display.
fn capture_with(
    backend: &impl CaptureSource,
    window: Window,
    max_dimension: Option<u32>,
) -> Result<Capture, ProtocolError> {
    let (width, height) = backend.dimensions(window)?;
    let pixels = u64::from(width) * u64::from(height);
    if pixels == 0 || pixels > MAX_CAPTURE_PIXELS {
        return Err(err(
            format!("Refusing X11 capture of {width}x{height} window (64MP limit)"),
            ErrorCode::CaptureFailed,
        ));
    }
    let pixmap = backend.name_pixmap(window)?;
    let (source, warnings) = if pixmap.is_some() {
        ("xcomposite", Vec::new())
    } else {
        (
            "get_image",
            vec![
                "XComposite unavailable; GetImage fallback may contain stale or obscured pixels"
                    .into(),
            ],
        )
    };
    let image = backend.read_image(pixmap.unwrap_or(window), width, height)?;
    if let Some(pixmap) = pixmap {
        backend.release_pixmap(pixmap);
    }
    let rgba = decode(
        &image.data,
        width,
        height,
        image.depth,
        backend.image_order(),
    )?;
    let (output_width, output_height) = scaled_dimensions(width, height, max_dimension);
    let rgba = resize_rgba(&rgba, width, height, output_width, output_height);
    let mut encoded = Vec::new();
    {
        let mut encoder =
            png::Encoder::new(&mut encoded, output_width.into(), output_height.into());
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(capture_err)?;
        writer.write_image_data(&rgba).map_err(capture_err)?;
    }
    Ok(Capture {
        png_base64: base64::engine::general_purpose::STANDARD.encode(encoded),
        width: output_width,
        height: output_height,
        source,
        warnings,
    })
}
fn scaled_dimensions(width: u16, height: u16, max_dimension: Option<u32>) -> (u16, u16) {
    let largest = u32::from(width.max(height));
    let Some(limit) = max_dimension.filter(|limit| *limit > 0 && *limit < largest) else {
        return (width, height);
    };
    let scale = f64::from(limit) / f64::from(largest);
    (
        (f64::from(width) * scale).round().max(1.0) as u16,
        (f64::from(height) * scale).round().max(1.0) as u16,
    )
}

fn resize_rgba(
    source: &[u8],
    source_width: u16,
    source_height: u16,
    width: u16,
    height: u16,
) -> Vec<u8> {
    if (source_width, source_height) == (width, height) {
        return source.to_vec();
    }
    let mut output = vec![0; usize::from(width) * usize::from(height) * 4];
    for y in 0..height {
        let source_y = (u32::from(y) * u32::from(source_height) / u32::from(height)) as usize;
        for x in 0..width {
            let source_x = (u32::from(x) * u32::from(source_width) / u32::from(width)) as usize;
            let from = (source_y * usize::from(source_width) + source_x) * 4;
            let to = (usize::from(y) * usize::from(width) + usize::from(x)) * 4;
            output[to..to + 4].copy_from_slice(&source[from..from + 4]);
        }
    }
    output
}

fn decode(
    data: &[u8],
    w: u16,
    h: u16,
    depth: u8,
    order: ImageOrder,
) -> Result<Vec<u8>, ProtocolError> {
    let expected = usize::from(w) * usize::from(h) * 4;
    if !matches!(depth, 24 | 32) || data.len() < expected {
        return Err(err(
            format!(
                "Unsupported X11 image layout: depth {depth}, {} bytes",
                data.len()
            ),
            ErrorCode::CaptureFailed,
        ));
    }
    let mut out = Vec::with_capacity(expected);
    for p in data[..expected].as_chunks::<4>().0 {
        let (r, g, b) = if order == ImageOrder::LSB_FIRST {
            (p[2], p[1], p[0])
        } else {
            (p[1], p[2], p[3])
        };
        out.extend_from_slice(&[r, g, b, 255]);
    }
    Ok(out)
}

/// Why a post did not confirm.
#[derive(Debug, Clone)]
pub enum PostFailure {
    /// The server refused the request: it had no effect.
    Rejected(ProtocolError),
    /// The request may have reached the server, which may have executed it.
    Uncertain(ProtocolError),
}
impl PostFailure {
    fn into_error(self) -> ProtocolError {
        match self {
            Self::Rejected(error) | Self::Uncertain(error) => error,
        }
    }
}

/// Destination for physical input events, so sequencing runs headless in tests.
///
/// `admit` and `admit_point` recheck the live target immediately before an effect.
/// `post` emits one event without admission: owed releases go through it, so a
/// refused target can never strand a held key or button.
pub trait InputSink {
    /// Refuse unless the target window is still mapped and active.
    fn admit(&self) -> Result<(), ProtocolError>;
    /// Refuse unless the screen point hits the target or one of its descendants:
    /// `occluded_target` when another window covers it, `coordinate_blocked` when
    /// it lies outside the target.
    fn admit_point(&self, x: i32, y: i32) -> Result<(), ProtocolError>;
    /// Resolve a keysym to a keycode, or `None` when the keymap lacks it.
    fn keycode(&self, sym: u32) -> Result<Option<Keycode>, ProtocolError>;
    /// Whether the key (or, when `button`, the pointer button) `detail` is down now,
    /// whoever pressed it, or `None` when the state source cannot observe that input.
    fn is_down(&self, button: bool, detail: u8) -> Result<Option<bool>, ProtocolError>;
    /// Post one event unconditionally.
    fn post(&self, event: u8, detail: u8, x: i32, y: i32) -> Result<(), PostFailure>;
}

/// The logical button core pointer state shows for physical button `detail` under the
/// pointer mapping `map` (`map[detail - 1]`), or `None` when it shows none: logical
/// buttons outside 1 to 5 (e.g. horizontal scroll 6 and 7), disabled (0) or unmapped.
pub fn observable_button(map: &[u8], detail: u8) -> Option<u8> {
    let logical = map.get(usize::from(detail).checked_sub(1)?).copied()?;
    (1..=5).contains(&logical).then_some(logical)
}

/// Live XTEST delivery pinned to one owning window.
pub struct XtestSink {
    conn: RustConnection,
    root: Window,
    target: Window,
}
impl InputSink for XtestSink {
    fn admit(&self) -> Result<(), ProtocolError> {
        validate_target(&self.conn, self.root, self.target)?;
        if active_window(&self.conn, self.root)? != Some(self.target) {
            return Err(err(
                "Refusing XTEST delivery because the owning window is no longer active",
                ErrorCode::ForegroundRequired,
            ));
        }
        Ok(())
    }
    fn admit_point(&self, x: i32, y: i32) -> Result<(), ProtocolError> {
        let (x, y) = (clamp_i16(x), clamp_i16(y));
        let hit = self
            .conn
            .translate_coordinates(self.root, self.root, x, y)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?
            .child;
        if hit != 0 && windows_related(&self.conn, hit, self.target)? {
            return Ok(());
        }
        let local = self
            .conn
            .translate_coordinates(self.root, self.target, x, y)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?;
        let geometry = self
            .conn
            .get_geometry(self.target)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?;
        let inside = (0..i32::from(geometry.width)).contains(&i32::from(local.dst_x))
            && (0..i32::from(geometry.height)).contains(&i32::from(local.dst_y));
        Err(if inside {
            err(
                "Refusing XTEST pointer delivery because another window covers the target point",
                ErrorCode::OccludedTarget,
            )
        } else {
            err(
                "Refusing XTEST pointer delivery because the point is outside the owning window",
                ErrorCode::CoordinateBlocked,
            )
        })
    }
    fn keycode(&self, sym: u32) -> Result<Option<Keycode>, ProtocolError> {
        let setup = self.conn.setup();
        let min = setup.min_keycode;
        let count = setup.max_keycode - min + 1;
        let m = self
            .conn
            .get_keyboard_mapping(min, count)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?;
        Ok(m.keysyms
            .chunks(usize::from(m.keysyms_per_keycode))
            .position(|s| s.contains(&sym))
            .map(|i| min + i as u8))
    }
    fn is_down(&self, button: bool, detail: u8) -> Result<Option<bool>, ProtocolError> {
        if button {
            // XTEST posts physical buttons; core pointer state carries logical buttons 1
            // to 5 as mask bits 8 to 12. Map through the pointer mapping, and report any
            // button outside those five (e.g. horizontal scroll 6 and 7) as unobservable.
            let map = self
                .conn
                .get_pointer_mapping()
                .map_err(xerr)?
                .reply()
                .map_err(xerr)?
                .map;
            let Some(logical) = observable_button(&map, detail) else {
                return Ok(None);
            };
            let mask = self
                .conn
                .query_pointer(self.root)
                .map_err(xerr)?
                .reply()
                .map_err(xerr)?
                .mask;
            return Ok(Some(u16::from(mask) & (1 << (7 + logical)) != 0));
        }
        let keys = self
            .conn
            .query_keymap()
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?
            .keys;
        Ok(Some(
            keys[usize::from(detail / 8)] & (1 << (detail % 8)) != 0,
        ))
    }
    fn post(&self, event: u8, detail: u8, x: i32, y: i32) -> Result<(), PostFailure> {
        // A send failure may follow a partial write; only an X11 error reply proves the
        // server refused the request. `check` flushes and waits for that answer.
        xtest::fake_input(
            &self.conn,
            event,
            detail,
            0,
            self.root,
            clamp_i16(x),
            clamp_i16(y),
            0,
        )
        .map_err(|e| PostFailure::Uncertain(xerr(e)))?
        .check()
        .map_err(|e| match e {
            ReplyError::X11Error(_) => PostFailure::Rejected(xerr(e)),
            ReplyError::ConnectionError(_) => PostFailure::Uncertain(xerr(e)),
        })
    }
}

/// A release still owed for a key or button this helper pressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Owed {
    /// `KEY_RELEASE_EVENT` or `BUTTON_RELEASE_EVENT`.
    event: u8,
    detail: u8,
    /// A release was submitted but its delivery is unknown. Never resent blindly:
    /// it is settled only by observing the input up, so one on an input the state
    /// source cannot observe stays owed.
    ambiguous: bool,
}
impl Owed {
    fn button(self) -> bool {
        self.event == BUTTON_RELEASE_EVENT
    }
    fn describe(self) -> String {
        if self.button() {
            format!("button {}", self.detail)
        } else {
            format!("keycode {}", self.detail)
        }
    }
    /// What stays owed after posting this release: nothing once confirmed, the same
    /// resendable release after a definite rejection, else a delivery-unknown one.
    fn after_post(self, result: &Result<(), PostFailure>) -> Option<Self> {
        match result {
            Ok(()) => None,
            Err(PostFailure::Rejected(_)) => Some(Self {
                ambiguous: false,
                ..self
            }),
            Err(PostFailure::Uncertain(_)) => Some(Self {
                ambiguous: true,
                ..self
            }),
        }
    }
    fn unknown(self) -> Self {
        Self {
            ambiguous: true,
            ..self
        }
    }
}

/// Inputs that may be held, under one lock: an exit snapshot and a cleanup handing a
/// failed release from `held` to `debt` exclude each other, so a snapshot never sees
/// the input in neither list.
#[derive(Debug, Default)]
struct Owing {
    /// Unconfirmed releases in press order; the newest is released first.
    debt: Vec<Owed>,
    /// Inputs a running action registered before submitting their press and has not
    /// confirmed released yet. An exit that cannot wait for that action names them.
    held: Vec<Owed>,
}
impl Owing {
    fn unhold(&mut self, owed: Owed) {
        if let Some(index) = self
            .held
            .iter()
            .rposition(|entry| entry.event == owed.event && entry.detail == owed.detail)
        {
            self.held.remove(index);
        }
    }
    /// Owed releases for an exit report: delivery-unknown ones say so.
    fn report(&self) -> Vec<String> {
        self.debt
            .iter()
            .map(|owed| {
                let name = owed.describe();
                if owed.ambiguous {
                    format!("{name} (delivery unknown, never resent)")
                } else {
                    name
                }
            })
            .collect()
    }
}

/// Helper-wide physical input state shared by every action: releases a cleanup
/// could not confirm, inputs a running action pressed, and the shutdown flag. It lives
/// in this process only.
#[derive(Debug, Default)]
pub struct InputState {
    owing: Mutex<Owing>,
    cancelled: AtomicBool,
}
impl InputState {
    /// The process-wide state live delivery uses.
    pub fn shared() -> Arc<Self> {
        static SHARED: OnceLock<Arc<InputState>> = OnceLock::new();
        Arc::clone(SHARED.get_or_init(Arc::default))
    }
    /// Stop admitting physical input, for shutdown. Owed releases still run.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    /// Keys and buttons whose release is unconfirmed, e.g. `keycode 37`.
    pub fn unconfirmed_releases(&self) -> Vec<String> {
        self.owing()
            .debt
            .iter()
            .map(|owed| owed.describe())
            .collect()
    }
    /// Refuse while a release is unconfirmed.
    fn refusal(&self) -> Option<ProtocolError> {
        let unconfirmed = self.unconfirmed_releases();
        (!unconfirmed.is_empty()).then(|| {
            err(
                format!(
                    "Refusing physical input: the release of {} is unconfirmed",
                    unconfirmed.join(", ")
                ),
                ErrorCode::InputUnsafe,
            )
        })
    }
    /// A failure before owed releases could be consulted, e.g. on reconnect, still
    /// names them: the caller must learn the input may be held, not only the cause.
    fn with_owed(&self, error: ProtocolError) -> ProtocolError {
        match self.refusal() {
            Some(refusal) => err(
                format!(
                    "{}; they could not be settled: {}",
                    refusal.message, error.message
                ),
                ErrorCode::InputUnsafe,
            ),
            None => error,
        }
    }
    /// What an exit that cannot wait for running actions must name: owed releases, as
    /// in the exit report, then inputs a running action may hold. One snapshot.
    pub fn possibly_held(&self) -> Vec<String> {
        self.possibly_held_with(|| {})
    }
    /// [`Self::possibly_held`] with `between` run after the owed releases are read and
    /// before the held inputs are, inside the same lock.
    fn possibly_held_with(&self, between: impl FnOnce()) -> Vec<String> {
        let owing = self.owing();
        let mut names = owing.report();
        between();
        names.extend(
            owing
                .held
                .iter()
                .map(|owed| format!("{} (held by a running action)", owed.describe())),
        );
        names
    }
    /// Register `owed` as possibly held, before its press is submitted.
    fn hold(&self, owed: Owed) {
        self.owing().held.push(owed);
    }
    /// Its release is confirmed, or its press was rejected.
    fn unhold(&self, owed: Owed) {
        self.owing().unhold(owed);
    }
    /// A cleanup's result, in one step: `unconfirmed` joins the debt and `released`
    /// leaves the held list, so an exit sees each input in one of them.
    fn hand_over(&self, unconfirmed: Vec<Owed>, released: Vec<Owed>) {
        let mut owing = self.owing();
        owing.debt.extend(unconfirmed);
        for owed in released {
            owing.unhold(owed);
        }
    }
    /// Owed releases for an exit report: delivery-unknown ones say so.
    fn exit_report(&self) -> Vec<String> {
        self.owing().report()
    }
    /// The one transition for an owed release in the debt: replace the entry for the
    /// same input with `left`, or remove it when `left` is `None`.
    fn resolve(&self, owed: Owed, left: Option<Owed>) {
        let mut owing = self.owing();
        let debt = &mut owing.debt;
        let same = |entry: &Owed| entry.event == owed.event && entry.detail == owed.detail;
        if let Some(index) = debt.iter().rposition(same) {
            match left {
                Some(left) => debt[index] = left,
                None => {
                    debt.remove(index);
                }
            }
        }
    }
    fn owing(&self) -> std::sync::MutexGuard<'_, Owing> {
        // Plain data: a panic elsewhere cannot leave it inconsistent.
        self.owing.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Before the helper exits, try to settle owed releases on a fresh X11 connection
/// with no target window, waiting at most `limit`. Returns what stays owed, named for
/// stderr. See [`settle_for_exit`].
pub fn exit_settlement(state: Arc<InputState>, limit: Duration) -> Vec<String> {
    settle_for_exit(state, open_root_sink, limit)
}

/// Settle owed releases through [`Input::settle`] on a sink from `open`, waiting at
/// most `limit`. A release submitted when the wait ends was already marked
/// delivery-unknown by `settle`, so it is reported and kept that way, never resendable.
pub fn settle_for_exit<S, F>(state: Arc<InputState>, open: F, limit: Duration) -> Vec<String>
where
    S: InputSink + 'static,
    F: FnOnce() -> Result<S, ProtocolError> + Send + 'static,
{
    settle_for_exit_with(state, open, |finished| {
        let _ = finished.recv_timeout(limit);
    })
}

/// [`settle_for_exit`] with the wait for the settlement thread left to `wait`, which
/// gets the channel that thread signals when it is done.
fn settle_for_exit_with<S, F>(
    state: Arc<InputState>,
    open: F,
    wait: impl FnOnce(&std::sync::mpsc::Receiver<()>),
) -> Vec<String>
where
    S: InputSink + 'static,
    F: FnOnce() -> Result<S, ProtocolError> + Send + 'static,
{
    if state.owing().debt.is_empty() {
        return Vec::new();
    }
    let (done, finished) = std::sync::mpsc::channel();
    let worker = Arc::clone(&state);
    std::thread::spawn(move || {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if let Ok(sink) = open() {
                let _ = Input::with_state(sink, worker).settle();
            }
        }));
        let _ = done.send(());
    });
    wait(&finished);
    state.exit_report()
}

fn open_root_sink() -> Result<XtestSink, ProtocolError> {
    if SessionKind::detect() != SessionKind::X11 {
        return Err(err(
            "No X11 session to settle owed releases on",
            ErrorCode::CapabilityDeferred,
        ));
    }
    let (conn, root) = connect_xtest()?;
    Ok(XtestSink {
        conn,
        root,
        target: root,
    })
}

/// Check `policy` against `session`, then open the input connection with `open`. A
/// failure while releases are owed, e.g. a lost display or a failed XTEST negotiation
/// on reconnect, is `input_unsafe` naming them: the caller must learn the input may
/// still be held, not only the cause.
fn open_physical<T>(
    policy: PhysicalPolicy,
    session: SessionKind,
    state: &InputState,
    open: impl FnOnce() -> Result<T, ProtocolError>,
) -> Result<T, ProtocolError> {
    policy
        .require_physical(session)
        .and_then(|()| open())
        .map_err(|error| state.with_owed(error))
}

/// Guarded physical input. Every event is admitted against the live target first,
/// and every key or button pressed is owed a release on every exit path.
pub struct Input<S: InputSink = XtestSink> {
    sink: S,
    state: Arc<InputState>,
    delivered: Cell<usize>,
    uncertain: Cell<bool>,
}
impl Input<XtestSink> {
    /// Connect and settle earlier unconfirmed releases before focusing the target, so
    /// a release reaches the window its press did when nothing has changed since.
    pub fn connect(policy: PhysicalPolicy, target: Window) -> Result<Self, ProtocolError> {
        let state = InputState::shared();
        let (conn, root) = open_physical(policy, SessionKind::detect(), &state, connect_xtest)?;
        let input = Self::with_state(XtestSink { conn, root, target }, state);
        input.settle()?;
        validate_target(&input.sink.conn, root, target)?;
        prepare_focus(&input.sink.conn, root, target, policy, &input.state)?;
        Ok(input)
    }
}
impl<S: InputSink> Input<S> {
    /// Input with its own state, for one-off and test use.
    pub fn with_sink(sink: S) -> Self {
        Self::with_state(sink, Arc::default())
    }
    pub fn with_state(sink: S, state: Arc<InputState>) -> Self {
        Self {
            sink,
            state,
            delivered: Cell::new(0),
            uncertain: Cell::new(false),
        }
    }
    pub fn sink(&self) -> &S {
        &self.sink
    }
    pub fn state(&self) -> &InputState {
        &self.state
    }
    /// Events confirmed posted so far, including owed releases. Admission is per
    /// event, so a stop leaves every earlier event delivered and no later one.
    pub fn delivered_units(&self) -> usize {
        self.delivered.get()
    }
    /// Whether a post may have executed without confirmation, e.g. a lost reply.
    pub fn delivery_uncertain(&self) -> bool {
        self.uncertain.get()
    }
    /// Retry the releases an earlier cleanup could not confirm, newest first, and
    /// refuse with `input_unsafe` while any stays unconfirmed. An input already up is
    /// settled without posting. An ambiguous release is never resent: another client
    /// may hold that input now. These posts belong to the earlier action and are not
    /// counted.
    pub fn settle(&self) -> Result<(), ProtocolError> {
        let pending = self.state.owing().debt.clone();
        for owed in pending.into_iter().rev() {
            let left = catch_unwind(AssertUnwindSafe(|| self.settle_one(owed)))
                // A panic mid-post leaves its delivery unknown.
                .unwrap_or(Some(owed.unknown()));
            self.state.resolve(owed, left);
        }
        let names = self.state.unconfirmed_releases();
        if names.is_empty() {
            return Ok(());
        }
        Err(err(
            format!(
                "Refusing physical input: the release of {} is unconfirmed and it may still be held. Release it, then retry.",
                names.join(", ")
            ),
            ErrorCode::InputUnsafe,
        ))
    }
    /// Settle one owed release; returns it again while it stays owed.
    fn settle_one(&self, owed: Owed) -> Option<Owed> {
        match self.sink.is_down(owed.button(), owed.detail) {
            Ok(Some(false)) => None,
            // Down, or unobservable: only a confirmed release post settles it.
            Ok(Some(true) | None) if !owed.ambiguous => {
                // Delivery-unknown in the shared debt from submission on: a caller that
                // stops waiting now, e.g. an exit, must never see it as resendable.
                self.state.resolve(owed, Some(owed.unknown()));
                owed.after_post(&self.sink.post(owed.event, owed.detail, 0, 0))
            }
            Ok(Some(true) | None) | Err(_) => Some(owed),
        }
    }
    /// Pointer actions check their point up front, then recheck it before the motion
    /// and before every button press: a point can become covered while the same
    /// window stays active.
    pub fn move_pointer(&self, x: i32, y: i32) -> Result<(), ProtocolError> {
        self.fake_at(MOTION_NOTIFY_EVENT, 0, x, y)
    }
    pub fn click(&self, x: i32, y: i32, button: &str, count: u64) -> Result<(), ProtocolError> {
        let b = button_detail(button)?;
        self.preflight_point(x, y)?;
        self.fake_at(MOTION_NOTIFY_EVENT, 0, x, y)?;
        let mut held = Held::new(self);
        for _ in 0..count.clamp(1, 3) {
            held.tap_at(b, (x, y))?;
        }
        Ok(())
    }
    pub fn scroll(&self, x: i32, y: i32, dx: f64, dy: f64) -> Result<(), ProtocolError> {
        self.preflight_point(x, y)?;
        self.fake_at(MOTION_NOTIFY_EVENT, 0, x, y)?;
        let mut held = Held::new(self);
        for _ in 0..dy.abs().ceil().clamp(0., 100.) as usize {
            held.tap_at(if dy < 0. { 4 } else { 5 }, (x, y))?;
        }
        for _ in 0..dx.abs().ceil().clamp(0., 100.) as usize {
            held.tap_at(if dx < 0. { 6 } else { 7 }, (x, y))?;
        }
        Ok(())
    }
    /// Validate the whole path up front, then recheck the start before the motion and
    /// the press, and each destination before its motion.
    pub fn drag(&self, path: &[(i32, i32)], button: &str) -> Result<(), ProtocolError> {
        if path.len() < 2 {
            return Err(invalid("drag requires at least two points"));
        }
        let b = button_detail(button)?;
        for &(x, y) in path {
            self.preflight_point(x, y)?;
        }
        self.fake_at(MOTION_NOTIFY_EVENT, 0, path[0].0, path[0].1)?;
        let mut held = Held::new(self);
        held.press_at(b, path[0])?;
        for &(x, y) in &path[1..] {
            self.fake_at(MOTION_NOTIFY_EVENT, 0, x, y)?;
        }
        held.release()
    }
    pub fn type_text(&self, text: &str) -> Result<(), ProtocolError> {
        // Reject unsupported characters before the first post, not midway through.
        let keys = text
            .chars()
            .map(|ch| {
                char_keysym(ch)
                    .ok_or_else(|| invalid(format!("Unsupported XTEST character {ch:?}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut held = Held::new(self);
        for (sym, shift) in keys {
            if shift {
                held.press(
                    KEY_PRESS_EVENT,
                    KEY_RELEASE_EVENT,
                    self.key_code(SHIFT_KEYSYM)?,
                )?;
            }
            held.tap(KEY_PRESS_EVENT, KEY_RELEASE_EVENT, self.key_code(sym)?)?;
            if shift {
                held.release()?;
            }
        }
        Ok(())
    }
    pub fn keypress(&self, names: &[&str]) -> Result<(), ProtocolError> {
        if names.is_empty() {
            return Err(invalid("keypress requires keys"));
        }
        let syms = names
            .iter()
            .map(|n| named_keysym(n).ok_or_else(|| invalid(format!("Unsupported key '{n}'"))))
            .collect::<Result<Vec<_>, _>>()?;
        if (1..syms.len()).any(|i| syms[..i].contains(&syms[i])) {
            return Err(invalid("keypress repeats a key within one chord"));
        }
        let mut held = Held::new(self);
        for &s in &syms {
            held.press(KEY_PRESS_EVENT, KEY_RELEASE_EVENT, self.key_code(s)?)?;
        }
        for _ in &syms {
            held.release()?;
        }
        Ok(())
    }
    /// Refuse once shutdown began, or while an earlier release is unconfirmed, then
    /// recheck the live target. Runs before every unit.
    fn admit(&self) -> Result<(), ProtocolError> {
        if self.state.is_cancelled() {
            return Err(err(
                "Helper is shutting down; physical input stopped",
                ErrorCode::Cancelled,
            ));
        }
        if let Some(refusal) = self.state.refusal() {
            return Err(refusal);
        }
        self.sink.admit()
    }
    fn preflight_point(&self, x: i32, y: i32) -> Result<(), ProtocolError> {
        self.admit()?;
        self.sink.admit_point(x, y)
    }
    fn key_code(&self, sym: u32) -> Result<Keycode, ProtocolError> {
        self.sink
            .keycode(sym)?
            .ok_or_else(|| invalid(format!("No keycode for keysym 0x{sym:x}")))
    }
    /// Admit the target and the point, then post one event.
    fn fake_at(&self, event: u8, detail: u8, x: i32, y: i32) -> Result<(), ProtocolError> {
        self.preflight_point(x, y)?;
        self.post(event, detail, x, y)
    }
    fn post(&self, event: u8, detail: u8, x: i32, y: i32) -> Result<(), ProtocolError> {
        self.post_checked(event, detail, x, y)
            .map_err(PostFailure::into_error)
    }
    /// Post one event without admission and account for it: a confirmed post counts,
    /// an unconfirmed one marks delivery uncertain.
    fn post_checked(&self, event: u8, detail: u8, x: i32, y: i32) -> Result<(), PostFailure> {
        let result = self.sink.post(event, detail, x, y);
        match &result {
            Ok(()) => self.delivered.set(self.delivered.get() + 1),
            Err(PostFailure::Uncertain(_)) => self.uncertain.set(true),
            Err(PostFailure::Rejected(_)) => {}
        }
        result
    }
    /// Release `owed` during cleanup. Returns it again when the release stays
    /// unconfirmed. An ambiguous release is settled by observing the input up, never
    /// resent.
    fn release_owed(&self, owed: Owed) -> Option<Owed> {
        if owed.ambiguous {
            return match self.sink.is_down(owed.button(), owed.detail) {
                Ok(Some(false)) => None,
                Ok(Some(true) | None) | Err(_) => Some(owed),
            };
        }
        owed.after_post(&self.post_checked(owed.event, owed.detail, 0, 0))
    }
}

const SHIFT_KEYSYM: u32 = 0xffe1;

/// Keys and buttons pressed and not yet released. Dropping it attempts every owed
/// release, newest first, without admission, each isolated by `catch_unwind` so a
/// panicking release cannot skip the rest. Releases it cannot confirm become
/// helper-wide debt that blocks further physical input until a later request
/// confirms them. Nothing runs under `panic = "abort"` or `SIGKILL`.
struct Held<'a, S: InputSink> {
    input: &'a Input<S>,
    owed: Vec<Owed>,
}
impl<'a, S: InputSink> Held<'a, S> {
    fn new(input: &'a Input<S>) -> Self {
        Self {
            input,
            owed: Vec::new(),
        }
    }
    /// Refuse an input that is already down, since its release would end another
    /// client's hold, then admit and press. An input whose state cannot be observed is
    /// pressed. A rejected press is not owed; an uncertain one is, because the server
    /// may have executed it.
    fn press(&mut self, press: u8, release: u8, detail: u8) -> Result<(), ProtocolError> {
        let input = self.input;
        self.press_admitted(press, release, detail, || input.admit())
    }
    /// Press pointer button `detail`, admitting the target and `point` at effect.
    fn press_at(&mut self, detail: u8, (x, y): (i32, i32)) -> Result<(), ProtocolError> {
        let input = self.input;
        self.press_admitted(BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, detail, || {
            input.preflight_point(x, y)
        })
    }
    fn press_admitted(
        &mut self,
        press: u8,
        release: u8,
        detail: u8,
        admit: impl FnOnce() -> Result<(), ProtocolError>,
    ) -> Result<(), ProtocolError> {
        let button = release == BUTTON_RELEASE_EVENT;
        if self.input.sink.is_down(button, detail)? == Some(true) {
            let name = Owed {
                event: release,
                detail,
                ambiguous: false,
            }
            .describe();
            return Err(err(
                format!("Refusing to press {name}: it is already held"),
                ErrorCode::InputUnsafe,
            ));
        }
        admit()?;
        let owed = Owed {
            event: release,
            detail,
            ambiguous: false,
        };
        self.owed.push(owed);
        // Visible to an exit before submission: the server may execute the press even
        // if its reply never comes back.
        self.input.state.hold(owed);
        match self.input.post_checked(press, detail, 0, 0) {
            Err(PostFailure::Rejected(error)) => {
                self.owed.pop();
                self.input.state.unhold(owed);
                Err(error)
            }
            result => result.map_err(PostFailure::into_error),
        }
    }
    /// Admit and release the newest owed input; a no-op when nothing is held. Sequences
    /// release in reverse press order, so the newest is always the one to release. It
    /// stays owed until the post confirms, and is ambiguous from submission until the
    /// sink definitely rejects it.
    fn release(&mut self) -> Result<(), ProtocolError> {
        let Some(&owed) = self.owed.last() else {
            return Ok(());
        };
        self.input.admit()?;
        // Ambiguous from submission on: a panic inside the sink must not leave it
        // looking unsent, or cleanup would release it a second time.
        if let Some(last) = self.owed.last_mut() {
            last.ambiguous = true;
        }
        match self.input.post_checked(owed.event, owed.detail, 0, 0) {
            Ok(()) => {
                self.owed.pop();
                self.input.state.unhold(owed);
                Ok(())
            }
            Err(PostFailure::Rejected(error)) => {
                // A definite rejection had no effect: the release may be sent again.
                if let Some(last) = self.owed.last_mut() {
                    last.ambiguous = false;
                }
                Err(error)
            }
            Err(PostFailure::Uncertain(error)) => Err(error),
        }
    }
    fn tap(&mut self, press: u8, release: u8, detail: u8) -> Result<(), ProtocolError> {
        self.press(press, release, detail)?;
        self.release()
    }
    fn tap_at(&mut self, detail: u8, point: (i32, i32)) -> Result<(), ProtocolError> {
        self.press_at(detail, point)?;
        self.release()
    }
}
impl<S: InputSink> Drop for Held<'_, S> {
    fn drop(&mut self) {
        let mut unconfirmed = Vec::new();
        let mut released = Vec::new();
        while let Some(owed) = self.owed.pop() {
            let input = self.input;
            let left = catch_unwind(AssertUnwindSafe(|| input.release_owed(owed)))
                // A panic mid-post leaves its delivery unknown.
                .unwrap_or(Some(owed.unknown()));
            unconfirmed.extend(left);
            released.push(owed);
        }
        unconfirmed.reverse();
        self.input.state.hand_over(unconfirmed, released);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FocusPlan {
    Confirm,
    ActivateAndConfirm,
}

fn focus_plan(policy: PhysicalPolicy, active: bool) -> Result<FocusPlan, ProtocolError> {
    match policy {
        PhysicalPolicy::Foreground => Ok(FocusPlan::ActivateAndConfirm),
        PhysicalPolicy::Default if active => Ok(FocusPlan::Confirm),
        PhysicalPolicy::Default => Err(err(
            "Default policy requires the owning X11 window to already be active",
            ErrorCode::ForegroundRequired,
        )),
        PhysicalPolicy::AxOnly | PhysicalPolicy::Background => {
            policy.require_physical(SessionKind::X11)?;
            unreachable!()
        }
    }
}
fn prepare_focus(
    c: &RustConnection,
    root: Window,
    target: Window,
    policy: PhysicalPolicy,
    state: &InputState,
) -> Result<(), ProtocolError> {
    let plan = focus_plan(policy, active_window(c, root)? == Some(target))?;
    if plan == FocusPlan::ActivateAndConfirm {
        request_active_window(c, root, target, state)?;
    }
    for _ in 0..20 {
        if active_window(c, root)? == Some(target) {
            return Ok(());
        }
        if plan == FocusPlan::Confirm {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Err(err(
        "Window manager did not activate the owning X11 window; refusing XTEST delivery",
        ErrorCode::ForegroundRequired,
    ))
}
fn validate_target(c: &RustConnection, root: Window, target: Window) -> Result<(), ProtocolError> {
    if target == 0 || target == root {
        return Err(err(
            "XTEST requires a specific owning X11 window",
            ErrorCode::CoordinateBlocked,
        ));
    }
    let attributes = c
        .get_window_attributes(target)
        .map_err(xerr)?
        .reply()
        .map_err(|_| {
            err(
                "Owning X11 window no longer exists",
                ErrorCode::TargetNotFound,
            )
        })?;
    let geometry = c.get_geometry(target).map_err(xerr)?.reply().map_err(|_| {
        err(
            "Owning X11 window has no usable geometry",
            ErrorCode::CoordinateBlocked,
        )
    })?;
    let atoms = Atoms::new(c)?;
    if attributes.map_state != MapState::VIEWABLE
        || geometry.width == 0
        || geometry.height == 0
        || property32(c, target, atoms.state, AtomEnum::ATOM.into()).contains(&atoms.hidden)
    {
        return Err(err(
            "Owning X11 window is not mapped and visible",
            ErrorCode::CoordinateBlocked,
        ));
    }
    Ok(())
}
fn active_window(c: &RustConnection, root: Window) -> Result<Option<Window>, ProtocolError> {
    let atom = intern(c, "_NET_ACTIVE_WINDOW")?;
    Ok(property32(c, root, atom, AtomEnum::WINDOW.into())
        .first()
        .copied())
}
fn request_active_window(
    c: &RustConnection,
    root: Window,
    target: Window,
    state: &InputState,
) -> Result<(), ProtocolError> {
    activate_unless_cancelled(
        state,
        || intern(c, "_NET_ACTIVE_WINDOW"),
        |atom| send_active_window(c, root, target, atom),
    )
}
fn windows_related(c: &RustConnection, hit: Window, target: Window) -> Result<bool, ProtocolError> {
    fn ancestors(c: &RustConnection, mut w: Window) -> Result<Vec<Window>, ProtocolError> {
        let mut out = vec![w];
        for _ in 0..64 {
            let tree = c.query_tree(w).map_err(xerr)?.reply().map_err(xerr)?;
            if tree.parent == 0 || tree.parent == w {
                break;
            }
            w = tree.parent;
            out.push(w);
        }
        Ok(out)
    }
    Ok(ancestors(c, hit)?.contains(&target) || ancestors(c, target)?.contains(&hit))
}
fn clamp_i16(value: i32) -> i16 {
    value.clamp(i16::MIN.into(), i16::MAX.into()) as i16
}

fn button_detail(b: &str) -> Result<u8, ProtocolError> {
    match b {
        "left" => Ok(ButtonIndex::M1.into()),
        "middle" => Ok(ButtonIndex::M2.into()),
        "right" => Ok(ButtonIndex::M3.into()),
        _ => Err(invalid(format!("Unsupported mouse button '{b}'"))),
    }
}
fn char_keysym(c: char) -> Option<(u32, bool)> {
    if c == '\n' {
        return Some((0xff0d, false));
    }
    if c == '\t' {
        return Some((0xff09, false));
    }
    if c == ' ' || c.is_ascii_lowercase() || c.is_ascii_digit() {
        return Some((c as u32, false));
    }
    if c.is_ascii_uppercase() {
        return Some((c.to_ascii_lowercase() as u32, true));
    }
    let shifted = "~!@#$%^&*()_+{}|:\"<>?";
    let base = "`1234567890-=[]\\;',./";
    shifted
        .chars()
        .position(|v| v == c)
        .and_then(|i| base.chars().nth(i))
        .map(|v| (v as u32, true))
}
fn named_keysym(n: &str) -> Option<u32> {
    match n.to_ascii_lowercase().as_str() {
        "enter" | "return" => Some(0xff0d),
        "tab" => Some(0xff09),
        "escape" | "esc" => Some(0xff1b),
        "backspace" => Some(0xff08),
        "delete" => Some(0xffff),
        "space" => Some(0x20),
        "left" => Some(0xff51),
        "up" => Some(0xff52),
        "right" => Some(0xff53),
        "down" => Some(0xff54),
        "home" => Some(0xff50),
        "end" => Some(0xff57),
        "pageup" => Some(0xff55),
        "pagedown" => Some(0xff56),
        "ctrl" | "control" => Some(0xffe3),
        "shift" => Some(0xffe1),
        "alt" | "option" => Some(0xffe9),
        "meta" | "super" | "cmd" | "command" => Some(0xffeb),
        v if v.len() == 1 => v.chars().next().map(|c| c as u32),
        v if v.starts_with('f') => v[1..]
            .parse::<u32>()
            .ok()
            .filter(|n| (1..=35).contains(n))
            .map(|n| 0xffbd + n),
        _ => None,
    }
}

struct Atoms {
    clients: Atom,
    stacking: Atom,
    active: Atom,
    pid: Atom,
    name: Atom,
    state: Atom,
    hidden: Atom,
    utf8: Atom,
}
impl Atoms {
    fn new(c: &RustConnection) -> Result<Self, ProtocolError> {
        Ok(Self {
            clients: intern(c, "_NET_CLIENT_LIST")?,
            stacking: intern(c, "_NET_CLIENT_LIST_STACKING")?,
            active: intern(c, "_NET_ACTIVE_WINDOW")?,
            pid: intern(c, "_NET_WM_PID")?,
            name: intern(c, "_NET_WM_NAME")?,
            state: intern(c, "_NET_WM_STATE")?,
            hidden: intern(c, "_NET_WM_STATE_HIDDEN")?,
            utf8: intern(c, "UTF8_STRING")?,
        })
    }
}
/// Connect and negotiate XTEST, returning the connection and its root window.
fn connect_xtest() -> Result<(RustConnection, Window), ProtocolError> {
    let (conn, screen) = connect()?;
    let root = conn.setup().roots[screen].root;
    xtest::get_version(&conn, 2, 2)
        .map_err(xerr)?
        .reply()
        .map_err(|e| {
            err(
                format!("XTEST unavailable: {e}"),
                ErrorCode::CapabilityDeferred,
            )
        })?;
    Ok((conn, root))
}
fn connect() -> Result<(RustConnection, usize), ProtocolError> {
    x11rb::connect(None).map_err(|e| {
        err(
            format!("X11 unavailable: {e}"),
            ErrorCode::CapabilityDeferred,
        )
    })
}
fn intern(c: &RustConnection, n: &str) -> Result<Atom, ProtocolError> {
    c.intern_atom(false, n.as_bytes())
        .map_err(xerr)?
        .reply()
        .map(|r| r.atom)
        .map_err(xerr)
}
fn property32(c: &RustConnection, w: Window, p: Atom, t: Atom) -> Vec<u32> {
    c.get_property(false, w, p, t, 0, u32::MAX)
        .ok()
        .and_then(|v| v.reply().ok())
        .and_then(|v| v.value32().map(Iterator::collect))
        .unwrap_or_default()
}
fn title(c: &RustConnection, w: Window, a: &Atoms) -> String {
    let utf = c
        .get_property(false, w, a.name, a.utf8, 0, 4096)
        .ok()
        .and_then(|v| v.reply().ok())
        .and_then(|v| String::from_utf8(v.value).ok())
        .unwrap_or_default();
    if !utf.is_empty() {
        return utf;
    }
    c.get_property(false, w, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 4096)
        .ok()
        .and_then(|v| v.reply().ok())
        .map(|v| String::from_utf8_lossy(&v.value).into_owned())
        .unwrap_or_default()
}
fn err(m: impl Into<String>, code: ErrorCode) -> ProtocolError {
    ProtocolError::new(m, code)
}
fn invalid(m: impl Into<String>) -> ProtocolError {
    err(m, ErrorCode::InvalidRequest)
}
fn xerr(e: impl std::fmt::Display) -> ProtocolError {
    err(format!("X11 request failed: {e}"), ErrorCode::InternalError)
}
fn capture_err(e: impl std::fmt::Display) -> ProtocolError {
    err(
        format!("PNG encoding failed: {e}"),
        ErrorCode::CaptureFailed,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::RecordingSink;
    use std::cell::RefCell;
    use std::io::Cursor;

    #[derive(Debug, PartialEq)]
    enum CaptureCall {
        Dimensions(Window),
        NamePixmap(Window),
        ReadImage(Drawable, u16, u16),
        ReleasePixmap(Drawable),
    }

    struct CaptureFixture {
        calls: RefCell<Vec<CaptureCall>>,
        size: (u16, u16),
        pixmap: Option<Drawable>,
        order: ImageOrder,
        image: GetImageReply,
    }

    impl CaptureSource for CaptureFixture {
        fn dimensions(&self, window: Window) -> Result<(u16, u16), ProtocolError> {
            self.calls
                .borrow_mut()
                .push(CaptureCall::Dimensions(window));
            Ok(self.size)
        }

        fn name_pixmap(&self, window: Window) -> Result<Option<Drawable>, ProtocolError> {
            self.calls
                .borrow_mut()
                .push(CaptureCall::NamePixmap(window));
            Ok(self.pixmap)
        }

        fn read_image(
            &self,
            drawable: Drawable,
            w: u16,
            h: u16,
        ) -> Result<GetImageReply, ProtocolError> {
            self.calls
                .borrow_mut()
                .push(CaptureCall::ReadImage(drawable, w, h));
            Ok(self.image.clone())
        }

        fn release_pixmap(&self, pixmap: Drawable) {
            self.calls
                .borrow_mut()
                .push(CaptureCall::ReleasePixmap(pixmap));
        }

        fn image_order(&self) -> ImageOrder {
            self.order
        }
    }

    #[test]
    fn capture_selects_drawable_and_encodes_the_requested_pixels() {
        use CaptureCall::{Dimensions, NamePixmap, ReadImage, ReleasePixmap};
        for (pixmap, order, data) in [
            (
                Some(32),
                ImageOrder::LSB_FIRST,
                vec![30, 20, 10, 0, 60, 50, 40, 0],
            ),
            (
                None,
                ImageOrder::MSB_FIRST,
                vec![0, 10, 20, 30, 0, 40, 50, 60],
            ),
        ] {
            let fixture = CaptureFixture {
                calls: RefCell::default(),
                size: (2, 1),
                pixmap,
                order,
                image: GetImageReply {
                    depth: 24,
                    sequence: 0,
                    visual: 0,
                    data,
                },
            };
            let capture = capture_with(&fixture, 17, Some(1)).unwrap();
            let mut calls = vec![
                Dimensions(17),
                NamePixmap(17),
                ReadImage(pixmap.unwrap_or(17), 2, 1),
            ];
            if let Some(drawable) = pixmap {
                calls.push(ReleasePixmap(drawable));
                assert_eq!(capture.source, "xcomposite");
                assert!(capture.warnings.is_empty());
            } else {
                assert_eq!(capture.source, "get_image");
                assert_eq!(capture.warnings, ["XComposite unavailable; GetImage fallback may contain stale or obscured pixels"]);
            }
            assert_eq!(fixture.calls.into_inner(), calls);
            assert_eq!((capture.width, capture.height), (1, 1));
            let encoded = base64::engine::general_purpose::STANDARD
                .decode(capture.png_base64)
                .unwrap();
            let mut png = png::Decoder::new(Cursor::new(encoded)).read_info().unwrap();
            let mut rgba = vec![0; png.output_buffer_size()];
            let output = png.next_frame(&mut rgba).unwrap();
            assert_eq!((output.width, output.height), (1, 1));
            assert_eq!(output.color_type, png::ColorType::Rgba);
            assert_eq!(rgba, [10, 20, 30, 255]);
        }

        for size in [(0, 64), (8193, 8192)] {
            let fixture = CaptureFixture {
                calls: RefCell::default(),
                size,
                pixmap: None,
                order: ImageOrder::LSB_FIRST,
                image: GetImageReply {
                    depth: 24,
                    sequence: 0,
                    visual: 0,
                    data: vec![],
                },
            };
            let error = capture_with(&fixture, 17, Some(1)).err().unwrap();
            assert_eq!(error.code, ErrorCode::CaptureFailed);
            assert!(error.message.contains("64MP limit"));
            assert_eq!(fixture.calls.into_inner(), [Dimensions(17)]);
        }
    }
    #[test]
    fn policy_guards() {
        // Strict headless is `foreground_required` in every session kind (#1298).
        for session in [
            SessionKind::X11,
            SessionKind::Wayland,
            SessionKind::Headless,
        ] {
            let error = PhysicalPolicy::AxOnly
                .require_physical(session)
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::ForegroundRequired, "{session:?}");
            assert!(error.message.starts_with("ax_only"), "{}", error.message);
        }
        // Outside strict headless the session decides first.
        for policy in [PhysicalPolicy::Default, PhysicalPolicy::Background] {
            assert_eq!(
                policy
                    .require_physical(SessionKind::Wayland)
                    .unwrap_err()
                    .code,
                ErrorCode::CapabilityDeferred
            );
            assert_eq!(
                policy
                    .require_physical(SessionKind::Headless)
                    .unwrap_err()
                    .code,
                ErrorCode::CoordinateBlocked
            );
        }
        assert_eq!(
            PhysicalPolicy::Background
                .require_physical(SessionKind::X11)
                .unwrap_err()
                .code,
            ErrorCode::ForegroundRequired
        );
        assert!(PhysicalPolicy::Foreground
            .require_physical(SessionKind::X11)
            .is_ok());
        assert!(PhysicalPolicy::Default
            .require_physical(SessionKind::X11)
            .is_ok());
    }
    #[test]
    fn focus_does_not_send_after_shutdown() {
        // Shutdown begins while the atom lookup blocks: the request is never sent.
        let state = InputState::default();
        let sent = Cell::new(false);
        let result = activate_unless_cancelled(
            &state,
            || {
                state.cancel();
                Ok(())
            },
            |()| {
                sent.set(true);
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        assert!(!sent.get(), "no _NET_ACTIVE_WINDOW after shutdown began");

        // Otherwise it is sent, and a failed preparation sends nothing.
        let state = InputState::default();
        activate_unless_cancelled(
            &state,
            || Ok(()),
            |()| {
                sent.set(true);
                Ok(())
            },
        )
        .unwrap();
        assert!(sent.replace(false));
        let failed = activate_unless_cancelled(
            &state,
            || Err::<(), _>(err("no atom", ErrorCode::InternalError)),
            |()| {
                sent.set(true);
                Ok(())
            },
        );
        assert_eq!(failed.unwrap_err().code, ErrorCode::InternalError);
        assert!(!sent.get());
    }

    #[test]
    fn focus_policy_is_deterministic() {
        assert_eq!(
            focus_plan(PhysicalPolicy::Foreground, false).unwrap(),
            FocusPlan::ActivateAndConfirm
        );
        assert_eq!(
            focus_plan(PhysicalPolicy::Foreground, true).unwrap(),
            FocusPlan::ActivateAndConfirm
        );
        assert_eq!(
            focus_plan(PhysicalPolicy::Default, true).unwrap(),
            FocusPlan::Confirm
        );
        assert_eq!(
            focus_plan(PhysicalPolicy::Default, false).unwrap_err().code,
            ErrorCode::ForegroundRequired
        );
        assert_eq!(
            focus_plan(PhysicalPolicy::Background, true)
                .unwrap_err()
                .code,
            ErrorCode::ForegroundRequired
        );
    }
    #[test]
    fn coordinate_clamping_is_deterministic() {
        assert_eq!(clamp_i16(i32::MIN), i16::MIN);
        assert_eq!(clamp_i16(i32::MAX), i16::MAX);
        assert_eq!(clamp_i16(42), 42);
    }
    #[test]
    fn geometry_is_deterministic() {
        let a = Rect {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
        };
        assert_eq!(distance(Some(&a), &a), 0);
        assert_eq!(distance(Some(&a), &Rect { x: 6, ..a.clone() }), 5);
    }
    #[test]
    fn key_protocol() {
        assert_eq!(named_keysym("Control"), Some(0xffe3));
        assert_eq!(named_keysym("F12"), Some(0xffc9));
        assert_eq!(char_keysym('A'), Some(('a' as u32, true)));
        assert_eq!(char_keysym('!'), Some(('1' as u32, true)));
        assert_eq!(char_keysym('é'), None);
    }
    #[test]
    fn bounded_capture_dimensions_preserve_aspect_ratio() {
        assert_eq!(scaled_dimensions(1920, 1080, Some(1000)), (1000, 563));
        assert_eq!(scaled_dimensions(800, 600, Some(1000)), (800, 600));
        assert_eq!(scaled_dimensions(1, 4000, Some(100)), (1, 100));
        assert_eq!(scaled_dimensions(4000, 1, Some(100)), (100, 1));
    }
    #[test]
    fn rgba_resize_is_bounded_and_deterministic() {
        let source = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        assert_eq!(resize_rgba(&source, 2, 2, 1, 1), vec![1, 2, 3, 4]);
        assert_eq!(resize_rgba(&source, 2, 2, 2, 2), source);
    }
    /// `(kind, detail, admitted)` per recorded event, keycodes in first-use order from 8.
    fn trace(input: &Input<RecordingSink>) -> Vec<(&'static str, u8, bool)> {
        input
            .sink()
            .events()
            .iter()
            .map(|e| {
                let kind = match e.event {
                    KEY_PRESS_EVENT => "key+",
                    KEY_RELEASE_EVENT => "key-",
                    BUTTON_PRESS_EVENT => "button+",
                    BUTTON_RELEASE_EVENT => "button-",
                    _ => "move",
                };
                (kind, e.detail, e.admitted)
            })
            .collect()
    }

    #[test]
    fn completed_input_admits_every_event_and_counts_it() {
        let input = Input::with_sink(RecordingSink::default());
        input.click(5, 6, "left", 2).unwrap();
        assert_eq!(
            trace(&input),
            [
                ("move", 0, true),
                ("button+", 1, true),
                ("button-", 1, true),
                ("button+", 1, true),
                ("button-", 1, true),
            ]
        );
        assert_eq!(
            (input.sink().events()[0].x, input.sink().events()[0].y),
            (5, 6)
        );
        assert_eq!(input.delivered_units(), 5);
        let input = Input::with_sink(RecordingSink::default());
        input.type_text("aA").unwrap();
        input.keypress(&["control", "a"]).unwrap();
        input.move_pointer(1, 2).unwrap();
        assert_eq!(
            trace(&input),
            [
                ("key+", 8, true),
                ("key-", 8, true),
                ("key+", 9, true),
                ("key+", 8, true),
                ("key-", 8, true),
                ("key-", 9, true),
                ("key+", 10, true),
                ("key+", 8, true),
                ("key-", 8, true),
                ("key-", 10, true),
                ("move", 0, true),
            ]
        );
    }

    #[test]
    fn refusal_after_a_press_releases_owed_input_without_admission() {
        // Drag: three point preflights, the start motion and the press are admitted.
        let input = Input::with_sink(RecordingSink::default().refuse_admission_after(5));
        let error = input.drag(&[(1, 1), (2, 2), (3, 3)], "right").unwrap_err();
        assert_eq!(error.code, ErrorCode::ForegroundRequired);
        assert_eq!(
            trace(&input),
            [
                ("move", 0, true),
                ("button+", 3, true),
                ("button-", 3, false)
            ]
        );
        assert_eq!(input.delivered_units(), 3);

        // Chord refused before its third key: both held modifiers release, newest first.
        let input = Input::with_sink(RecordingSink::default().refuse_admission_after(2));
        let error = input.keypress(&["control", "shift", "a"]).unwrap_err();
        assert_eq!(error.code, ErrorCode::ForegroundRequired);
        assert_eq!(
            trace(&input),
            [
                ("key+", 8, true),
                ("key+", 9, true),
                ("key-", 9, false),
                ("key-", 8, false),
            ]
        );

        // Chord refused while releasing: each key is released exactly once.
        let input = Input::with_sink(RecordingSink::default().refuse_admission_after(3));
        input.keypress(&["control", "a"]).unwrap_err();
        assert_eq!(
            trace(&input),
            [
                ("key+", 8, true),
                ("key+", 9, true),
                ("key-", 9, true),
                ("key-", 8, false),
            ]
        );

        // Typing refused after shift: shift releases and the shifted key never posts.
        let input = Input::with_sink(RecordingSink::default().refuse_admission_after(3));
        input.type_text("aB").unwrap_err();
        assert_eq!(
            trace(&input),
            [
                ("key+", 8, true),
                ("key-", 8, true),
                ("key+", 9, true),
                ("key-", 9, false),
            ]
        );
        assert_eq!(input.delivered_units(), 4);

        // Scroll refused on the second notch release.
        let input = Input::with_sink(RecordingSink::default().refuse_admission_after(5));
        input.scroll(0, 0, 0.0, 3.0).unwrap_err();
        assert_eq!(
            trace(&input),
            [
                ("move", 0, true),
                ("button+", 5, true),
                ("button-", 5, true),
                ("button+", 5, true),
                ("button-", 5, false),
            ]
        );
    }

    #[test]
    fn failed_posts_and_missing_keys_still_release_held_input() {
        // The server rejects the second press: it is not owed, only control releases.
        let input = Input::with_sink(RecordingSink::default().fail_post(1));
        let error = input.keypress(&["control", "a"]).unwrap_err();
        assert_eq!(error.code, ErrorCode::InternalError);
        assert_eq!(trace(&input), [("key+", 8, true), ("key-", 8, false)]);
        assert_eq!(input.delivered_units(), 2);
        assert!(!input.delivery_uncertain());
        assert!(input.state().unconfirmed_releases().is_empty());

        // The release post is rejected: it stays owed and is retried once on unwind.
        let input = Input::with_sink(RecordingSink::default().fail_post(2));
        input.keypress(&["control", "a"]).unwrap_err();
        assert_eq!(
            trace(&input),
            [
                ("key+", 8, true),
                ("key+", 9, true),
                ("key-", 9, false),
                ("key-", 8, false),
            ]
        );
        assert!(input.state().unconfirmed_releases().is_empty());

        // A key missing from the keymap mid-chord releases the keys already down.
        let input = Input::with_sink(RecordingSink::default().unmapped('a' as u32));
        let error = input.keypress(&["control", "a"]).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidRequest);
        assert_eq!(trace(&input), [("key+", 8, true), ("key-", 8, false)]);
    }

    #[test]
    fn an_unconfirmed_cleanup_becomes_debt_that_blocks_input_until_settled() {
        // The action is refused while control is held, and its cleanup release fails.
        let state = Arc::new(InputState::default());
        let sink = RecordingSink::default()
            .refuse_admission_after(1)
            .fail_post(1);
        let input = Input::with_state(sink, Arc::clone(&state));
        let error = input.keypress(&["control", "a"]).unwrap_err();
        assert_eq!(error.code, ErrorCode::ForegroundRequired);
        assert_eq!(trace(&input), [("key+", 8, true)]);
        assert_eq!(state.unconfirmed_releases(), ["keycode 8"]);

        // Every later unit is refused, naming the held key, before anything posts.
        let next = Input::with_state(RecordingSink::default(), Arc::clone(&state));
        let error = next.type_text("b").unwrap_err();
        assert_eq!(error.code, ErrorCode::InputUnsafe);
        assert!(error.message.contains("keycode 8"), "{}", error.message);
        assert!(next.sink().events().is_empty());

        // A retry whose release fails again keeps the debt and refuses.
        let retry = Input::with_state(
            RecordingSink::default().held(false, 8).fail_post(0),
            Arc::clone(&state),
        );
        assert_eq!(retry.settle().unwrap_err().code, ErrorCode::InputUnsafe);
        assert_eq!(state.unconfirmed_releases(), ["keycode 8"]);

        // A failed state query proves nothing either.
        let blind = Input::with_state(RecordingSink::default().query_fails(), Arc::clone(&state));
        assert_eq!(blind.settle().unwrap_err().code, ErrorCode::InputUnsafe);
        assert!(blind.sink().events().is_empty());

        // A confirmed release clears it, and is not counted against the new action.
        let settled =
            Input::with_state(RecordingSink::default().held(false, 8), Arc::clone(&state));
        settled.settle().unwrap();
        assert_eq!(trace(&settled), [("key-", 8, false)]);
        assert_eq!(settled.delivered_units(), 0);
        assert!(state.unconfirmed_releases().is_empty());
        settled.type_text("b").unwrap();

        // An input already up settles without posting.
        state.owing().debt.push(Owed {
            event: BUTTON_RELEASE_EVENT,
            detail: 1,
            ambiguous: false,
        });
        let up = Input::with_state(RecordingSink::default(), Arc::clone(&state));
        up.settle().unwrap();
        assert!(up.sink().events().is_empty());
    }

    #[test]
    fn reconnect_failure_names_unconfirmed_releases() {
        let negotiation = || {
            Err::<(), _>(err(
                "XTEST unavailable: extension missing",
                ErrorCode::CapabilityDeferred,
            ))
        };
        // Nothing owed: the cause is reported as it is.
        let clean = Arc::new(InputState::default());
        let error = open_physical(
            PhysicalPolicy::Default,
            SessionKind::X11,
            &clean,
            negotiation,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::CapabilityDeferred);

        // Owed releases turn the same failure into `input_unsafe` naming them.
        let state = owing(37);
        for open in [negotiation as fn() -> Result<(), ProtocolError>, || {
            Err(err(
                "X11 unavailable: no display",
                ErrorCode::CapabilityDeferred,
            ))
        }] {
            let error =
                open_physical(PhysicalPolicy::Default, SessionKind::X11, &state, open).unwrap_err();
            assert_eq!(error.code, ErrorCode::InputUnsafe);
            assert!(error.message.contains("keycode 37"), "{}", error.message);
            assert!(
                error.message.contains("could not be settled: X"),
                "{}",
                error.message
            );
        }
        // A session that lost X11 altogether says so too.
        let error = open_physical(
            PhysicalPolicy::Default,
            SessionKind::Wayland,
            &state,
            || Ok(()),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InputUnsafe);
        assert!(error.message.contains("keycode 37"), "{}", error.message);
        // A connection that opens is handed back for settlement.
        assert_eq!(
            open_physical(PhysicalPolicy::Default, SessionKind::X11, &state, || Ok(5)).unwrap(),
            5
        );
    }

    /// A sink that records, at every post, what an exit would name as possibly held.
    struct Watching {
        inner: RecordingSink,
        state: Arc<InputState>,
        seen: RefCell<Vec<Vec<String>>>,
    }
    impl InputSink for Watching {
        fn admit(&self) -> Result<(), ProtocolError> {
            self.inner.admit()
        }
        fn admit_point(&self, x: i32, y: i32) -> Result<(), ProtocolError> {
            self.inner.admit_point(x, y)
        }
        fn keycode(&self, sym: u32) -> Result<Option<Keycode>, ProtocolError> {
            self.inner.keycode(sym)
        }
        fn is_down(&self, button: bool, detail: u8) -> Result<Option<bool>, ProtocolError> {
            self.inner.is_down(button, detail)
        }
        fn post(&self, event: u8, detail: u8, x: i32, y: i32) -> Result<(), PostFailure> {
            self.seen.borrow_mut().push(self.state.possibly_held());
            self.inner.post(event, detail, x, y)
        }
    }

    fn watching(inner: RecordingSink) -> Input<Watching> {
        let state = Arc::new(InputState::default());
        let sink = Watching {
            inner,
            state: Arc::clone(&state),
            seen: RefCell::default(),
        };
        Input::with_state(sink, state)
    }

    #[test]
    fn a_press_is_visible_to_an_exit_before_it_is_submitted() {
        let input = watching(RecordingSink::default());
        input.type_text("A").unwrap();
        let held = "keycode 8 (held by a running action)";
        let both = vec![
            held.to_owned(),
            "keycode 9 (held by a running action)".to_owned(),
        ];
        // Shift press, `a` press, `a` release, shift release.
        assert_eq!(
            *input.sink().seen.borrow(),
            [
                vec![held.to_owned()],
                both.clone(),
                both,
                vec![held.to_owned()]
            ]
        );
        assert!(
            input.state().possibly_held().is_empty(),
            "all confirmed released"
        );

        // A rejected press is not held; an uncertain one stays named until cleanup
        // hands it to the debt.
        let input = watching(RecordingSink::default().fail_post(0));
        assert!(input.type_text("A").is_err());
        assert!(input.state().possibly_held().is_empty());
        let input = watching(RecordingSink::default().lose_ack(0, true).fail_post(1));
        assert!(input.type_text("A").is_err());
        assert_eq!(input.state().possibly_held(), ["keycode 8"]);
    }

    #[test]
    fn exit_snapshot_during_debt_transfer() {
        // A cleanup hands a failed release from the held list to the debt while an
        // exit snapshot is between its reads: the snapshot still names the input. The
        // window gives a racing transfer time to run; one lock keeps it out.
        let state = Arc::new(InputState::default());
        let owed = Owed {
            event: KEY_RELEASE_EVENT,
            detail: 8,
            ambiguous: false,
        };
        state.hold(owed);
        let (done, transferred) = std::sync::mpsc::channel();
        let cleanup = Arc::clone(&state);
        let mut worker = None;
        let snapshot = state.possibly_held_with(|| {
            worker = Some(std::thread::spawn(move || {
                cleanup.hand_over(vec![owed], vec![owed]);
                let _ = done.send(());
            }));
            let _ = transferred.recv_timeout(Duration::from_millis(300));
        });
        assert_eq!(snapshot, ["keycode 8 (held by a running action)"]);
        worker.expect("spawned").join().expect("transfer");
        assert_eq!(state.possibly_held(), ["keycode 8"]);
    }

    fn owing(detail: u8) -> Arc<InputState> {
        let state = Arc::new(InputState::default());
        state.owing().debt.push(Owed {
            event: KEY_RELEASE_EVENT,
            detail,
            ambiguous: false,
        });
        state
    }

    #[test]
    fn exit_settlement_that_times_out_keeps_the_release_delivery_unknown() {
        // The release is submitted, then the exit stops waiting before it confirms: the
        // wait ends when the sink signals the post began, not after an elapsed time. The
        // post stays open until the test releases it, after the snapshot.
        let state = owing(8);
        let (posts, posting) = std::sync::mpsc::channel();
        let (release, held_open) = std::sync::mpsc::channel();
        let left = settle_for_exit_with(
            Arc::clone(&state),
            move || {
                Ok(RecordingSink::default()
                    .held(false, 8)
                    .announce_posts(posts)
                    .hold_posts_until(held_open))
            },
            |_| {
                assert_eq!(posting.recv_timeout(Duration::from_secs(10)), Ok(0));
            },
        );
        assert_eq!(left, ["keycode 8 (delivery unknown, never resent)"]);
        assert!(
            state.owing().debt[0].ambiguous,
            "never resendable in-process"
        );
        let later = Input::with_state(RecordingSink::default().held(false, 8), state);
        assert_eq!(later.settle().unwrap_err().code, ErrorCode::InputUnsafe);
        assert!(later.sink().events().is_empty(), "never resent");
        release.send(()).expect("the held post is still waiting");

        // One that confirms in time is settled.
        let state = owing(8);
        let left = settle_for_exit(
            Arc::clone(&state),
            || Ok(RecordingSink::default().held(false, 8)),
            Duration::from_secs(5),
        );
        assert!(left.is_empty(), "{left:?}");
        assert!(state.unconfirmed_releases().is_empty());

        // No connection: nothing was submitted, so it stays a plain owed release.
        let state = owing(9);
        let left = settle_for_exit(
            Arc::clone(&state),
            || Err::<RecordingSink, _>(err("no display", ErrorCode::CapabilityDeferred)),
            Duration::from_secs(5),
        );
        assert_eq!(left, ["keycode 9"]);
        assert!(!state.owing().debt[0].ambiguous);

        // Nothing owed: no attempt.
        let left = settle_for_exit(
            Arc::new(InputState::default()),
            || -> Result<RecordingSink, ProtocolError> { panic!("must not connect") },
            Duration::from_secs(5),
        );
        assert!(left.is_empty());
    }

    #[test]
    fn first_post_ack_lost_is_uncertain_and_owed() {
        // The press is applied but its acknowledgment is lost, and cleanup is rejected.
        let state = Arc::new(InputState::default());
        let sink = RecordingSink::default().lose_ack(0, true).fail_post(1);
        let input = Input::with_state(sink, Arc::clone(&state));
        input.keypress(&["control"]).unwrap_err();
        assert_eq!(trace(&input), [("key+", 8, true)]);
        assert_eq!(input.delivered_units(), 0);
        assert!(input.delivery_uncertain());
        assert_eq!(state.unconfirmed_releases(), ["keycode 8"]);

        // The press was never confirmed, yet the next request releases it first.
        let next = Input::with_state(RecordingSink::default().held(false, 8), Arc::clone(&state));
        next.settle().unwrap();
        assert_eq!(trace(&next), [("key-", 8, false)]);
    }

    #[test]
    fn an_ambiguous_release_is_never_resent_blindly() {
        // The release was applied but unacknowledged: cleanup sees control up and stops.
        let input = Input::with_sink(RecordingSink::default().lose_ack(1, true));
        input.keypress(&["control"]).unwrap_err();
        assert_eq!(trace(&input), [("key+", 8, true), ("key-", 8, true)]);
        assert!(input.delivery_uncertain());
        assert!(input.state().unconfirmed_releases().is_empty());

        // Not applied: control is still down, but it may belong to another client now.
        let state = Arc::new(InputState::default());
        let sink = RecordingSink::default().lose_ack(1, false);
        let input = Input::with_state(sink, Arc::clone(&state));
        input.keypress(&["control"]).unwrap_err();
        assert_eq!(trace(&input), [("key+", 8, true)]);
        assert_eq!(state.unconfirmed_releases(), ["keycode 8"]);
        let held = Input::with_state(RecordingSink::default().held(false, 8), Arc::clone(&state));
        assert_eq!(held.settle().unwrap_err().code, ErrorCode::InputUnsafe);
        assert!(held.sink().events().is_empty(), "never resent");
        let up = Input::with_state(RecordingSink::default(), Arc::clone(&state));
        up.settle().unwrap();
        assert!(state.unconfirmed_releases().is_empty());

        // A failed query during cleanup keeps an ambiguous release owed.
        let input = Input::with_sink(RecordingSink::default().query_fails());
        let mut held = Held::new(&input);
        held.owed.push(Owed {
            event: KEY_RELEASE_EVENT,
            detail: 9,
            ambiguous: true,
        });
        drop(held);
        assert_eq!(input.state().unconfirmed_releases(), ["keycode 9"]);
        assert!(input.sink().events().is_empty());
    }

    #[test]
    fn a_panic_with_input_held_still_releases_every_owed_input() {
        // The second press panics with control down: both are released on unwind.
        let input = Input::with_sink(RecordingSink::default().panic_post(1));
        let outcome = catch_unwind(AssertUnwindSafe(|| input.keypress(&["control", "a"])));
        assert!(outcome.is_err());
        assert_eq!(
            trace(&input),
            [("key+", 8, true), ("key-", 9, false), ("key-", 8, false)]
        );

        // A panic inside one cleanup release does not skip the next.
        let input = Input::with_sink(
            RecordingSink::default()
                .refuse_admission_after(2)
                .panic_post(2),
        );
        let error = input.keypress(&["control", "shift", "a"]).unwrap_err();
        assert_eq!(error.code, ErrorCode::ForegroundRequired);
        assert_eq!(
            trace(&input),
            [("key+", 8, true), ("key+", 9, true), ("key-", 8, false)]
        );
        assert_eq!(input.state().unconfirmed_releases(), ["keycode 9"]);
    }

    #[test]
    fn unobservable_buttons_never_settle_debt_by_query() {
        // Horizontal scroll buttons have no core pointer state: the momentary press and
        // release still run, since no state can prove another client holds them.
        let input = Input::with_sink(RecordingSink::default().held(true, 7));
        input.scroll(0, 0, 1.0, 0.0).unwrap();
        assert_eq!(
            trace(&input),
            [
                ("move", 0, true),
                ("button+", 7, true),
                ("button-", 7, true)
            ]
        );

        // A release whose delivery is unknown is never settled by a query that cannot see it.
        let state = Arc::new(InputState::default());
        let sink = RecordingSink::default().lose_ack(2, true);
        let input = Input::with_state(sink, Arc::clone(&state));
        input.scroll(0, 0, 1.0, 0.0).unwrap_err();
        assert_eq!(state.unconfirmed_releases(), ["button 7"]);
        let later = Input::with_state(RecordingSink::default(), Arc::clone(&state));
        assert_eq!(later.settle().unwrap_err().code, ErrorCode::InputUnsafe);
        assert!(later.sink().events().is_empty(), "never resent");
        assert_eq!(state.unconfirmed_releases(), ["button 7"]);

        // An owed release that was never submitted settles only by a confirmed post.
        let state = Arc::new(InputState::default());
        state.owing().debt.push(Owed {
            event: BUTTON_RELEASE_EVENT,
            detail: 6,
            ambiguous: false,
        });
        let settled = Input::with_state(RecordingSink::default(), Arc::clone(&state));
        settled.settle().unwrap();
        assert_eq!(trace(&settled), [("button-", 6, false)]);
        assert!(state.unconfirmed_releases().is_empty());
    }

    #[test]
    fn observability_follows_the_pointer_mapping() {
        assert_eq!(observable_button(&[1, 2, 3, 4, 5, 6, 7], 5), Some(5));
        assert_eq!(observable_button(&[1, 2, 3, 4, 5, 6, 7], 7), None);
        assert_eq!(observable_button(&[3, 2, 1], 1), Some(3), "left-handed");
        assert_eq!(observable_button(&[1, 0, 3], 2), None, "disabled");
        assert_eq!(observable_button(&[1, 2, 3], 4), None, "unmapped");
        assert_eq!(observable_button(&[1, 2, 3], 0), None, "no button 0");

        // Physical 7 maps to logical 5 and physical 5 to logical 7.
        let swapped = [1, 2, 3, 4, 7, 6, 5];
        // Physical 7 is observable here, so a hold by another client refuses the press.
        let input = Input::with_sink(
            RecordingSink::default()
                .pointer_mapping(&swapped)
                .held(true, 7),
        );
        let error = input.scroll(0, 0, 1.0, 0.0).unwrap_err();
        assert_eq!(error.code, ErrorCode::InputUnsafe, "{}", error.message);
        assert_eq!(trace(&input), [("move", 0, true)]);
        // Physical 5 is not: its momentary press runs although another client holds it.
        let input = Input::with_sink(
            RecordingSink::default()
                .pointer_mapping(&swapped)
                .held(true, 5),
        );
        input.scroll(0, 0, 0.0, 1.0).unwrap();
        assert_eq!(
            trace(&input),
            [
                ("move", 0, true),
                ("button+", 5, true),
                ("button-", 5, true)
            ]
        );
        // And a delivery-unknown release of it is never settled by a query.
        let state = Arc::new(InputState::default());
        state.owing().debt.push(Owed {
            event: BUTTON_RELEASE_EVENT,
            detail: 5,
            ambiguous: true,
        });
        let later = Input::with_state(
            RecordingSink::default().pointer_mapping(&swapped),
            Arc::clone(&state),
        );
        assert_eq!(later.settle().unwrap_err().code, ErrorCode::InputUnsafe);
        assert_eq!(state.unconfirmed_releases(), ["button 5"]);
    }

    #[test]
    fn panic_after_normal_release_is_not_resent() {
        // The release reached the server, then the post panicked: delivery is unknown,
        // so cleanup observes control up instead of releasing it a second time.
        let input = Input::with_sink(RecordingSink::default().panic_after_post(1));
        let outcome = catch_unwind(AssertUnwindSafe(|| input.keypress(&["control"])));
        assert!(outcome.is_err());
        assert_eq!(trace(&input), [("key+", 8, true), ("key-", 8, true)]);
        assert!(input.state().unconfirmed_releases().is_empty());

        // The record turns ambiguous before the sink runs, so a panic cannot leave it
        // looking unsent.
        let input = Input::with_sink(RecordingSink::default().panic_after_post(1));
        let mut held = Held::new(&input);
        held.press(KEY_PRESS_EVENT, KEY_RELEASE_EVENT, 8).unwrap();
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let _ = held.release();
        }));
        assert!(outcome.is_err());
        assert_eq!(held.owed.len(), 1);
        assert!(held.owed[0].ambiguous, "marked before the sink ran");
    }

    #[test]
    fn cancellation_stops_before_the_next_unit_and_releases() {
        let state = Arc::new(InputState::default());
        let sink = RecordingSink::default().cancel_after(1, Arc::clone(&state));
        let input = Input::with_state(sink, Arc::clone(&state));
        let error = input.keypress(&["control", "a"]).unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(trace(&input), [("key+", 8, true), ("key-", 8, false)]);
        assert!(state.unconfirmed_releases().is_empty());
        let later = Input::with_state(RecordingSink::default(), state);
        assert_eq!(
            later.move_pointer(1, 1).unwrap_err().code,
            ErrorCode::Cancelled
        );
        assert!(later.sink().events().is_empty());
    }

    #[test]
    fn drag_rechecks_each_destination_at_effect() {
        // Three prevalidated points, then the third is covered after the first motion.
        let input = Input::with_sink(RecordingSink::default().cover_points_after(6));
        let error = input.drag(&[(1, 1), (2, 2), (3, 3)], "left").unwrap_err();
        assert_eq!(error.code, ErrorCode::OccludedTarget);
        assert_eq!(
            trace(&input),
            [
                ("move", 0, true),
                ("button+", 1, true),
                ("move", 0, true),
                ("button-", 1, false),
            ]
        );
        assert_eq!(input.sink().events()[2].x, 2);
    }

    #[test]
    fn drag_rechecks_start_before_press() {
        // The start is covered after the whole-path preflight: nothing posts.
        let input = Input::with_sink(RecordingSink::default().cover_points_after(3));
        let error = input.drag(&[(1, 1), (2, 2), (3, 3)], "left").unwrap_err();
        assert_eq!(error.code, ErrorCode::OccludedTarget);
        assert!(input.sink().events().is_empty());

        // Covered after the start motion: the button never goes down.
        let input = Input::with_sink(RecordingSink::default().cover_points_after(3));
        input.drag(&[(1, 1), (2, 2)], "left").unwrap_err();
        assert_eq!(trace(&input), [("move", 0, true)]);

        // Clicks and scrolls recheck their point before each press too.
        let input = Input::with_sink(RecordingSink::default().cover_points_after(2));
        input.click(1, 1, "left", 1).unwrap_err();
        assert_eq!(trace(&input), [("move", 0, true)]);
        let input = Input::with_sink(RecordingSink::default().cover_points_after(3));
        input.scroll(1, 1, 0.0, 3.0).unwrap_err();
        assert_eq!(
            trace(&input),
            [
                ("move", 0, true),
                ("button+", 5, true),
                ("button-", 5, true)
            ]
        );
    }

    #[test]
    fn input_already_held_by_another_client_is_refused() {
        let input = Input::with_sink(RecordingSink::default().held(false, 8));
        let error = input.keypress(&["control"]).unwrap_err();
        assert_eq!(error.code, ErrorCode::InputUnsafe);
        assert!(error.message.contains("keycode 8"), "{}", error.message);
        assert!(input.sink().events().is_empty());

        let input = Input::with_sink(RecordingSink::default().held(true, 1));
        assert_eq!(
            input.click(1, 1, "left", 1).unwrap_err().code,
            ErrorCode::InputUnsafe
        );
        assert_eq!(trace(&input), [("move", 0, true)]);

        let input = Input::with_sink(RecordingSink::default().query_fails());
        assert_eq!(
            input.keypress(&["control"]).unwrap_err().code,
            ErrorCode::InternalError
        );
        assert!(input.sink().events().is_empty());
    }

    #[test]
    fn rejected_input_posts_nothing() {
        let input = Input::with_sink(RecordingSink::default());
        assert_eq!(
            input.type_text("a\u{e9}").unwrap_err().code,
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            input.keypress(&["control", "nope"]).unwrap_err().code,
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            input.keypress(&[]).unwrap_err().code,
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            input.keypress(&["control", "Ctrl"]).unwrap_err().code,
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            input.drag(&[(1, 1)], "left").unwrap_err().code,
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            input.click(1, 1, "fourth", 1).unwrap_err().code,
            ErrorCode::InvalidRequest
        );
        let blocked = Input::with_sink(RecordingSink::default().refuse_points());
        assert_eq!(
            blocked.click(1, 1, "left", 1).unwrap_err().code,
            ErrorCode::CoordinateBlocked
        );
        assert_eq!(
            blocked.drag(&[(1, 1), (2, 2)], "left").unwrap_err().code,
            ErrorCode::CoordinateBlocked
        );
        assert_eq!(
            blocked.scroll(1, 1, 1.0, 0.0).unwrap_err().code,
            ErrorCode::CoordinateBlocked
        );
        assert_eq!(
            blocked.move_pointer(1, 1).unwrap_err().code,
            ErrorCode::CoordinateBlocked
        );
        assert!(input.sink().events().is_empty() && blocked.sink().events().is_empty());
        assert_eq!(input.delivered_units() + blocked.delivered_units(), 0);
    }

    #[test]
    fn decode_limits() {
        assert_eq!(
            decode(&[1, 2, 3, 0], 1, 1, 24, ImageOrder::LSB_FIRST).unwrap(),
            vec![3, 2, 1, 255]
        );
        assert!(decode(&[0; 2], 1, 1, 16, ImageOrder::LSB_FIRST).is_err());
    }
}
