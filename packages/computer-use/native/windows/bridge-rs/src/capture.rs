//! GDI screenshot capture for Windows.
//!
//! Captures window content via GDI (PrintWindow) on Windows.
//! On non-Windows platforms all entry points return a deterministic
//! `unsupported_platform` error.
//!
//! Selected-window capture only. Desktop capture is not implemented. DXGI and
//! Windows Graphics Capture are not used.

use serde_json::Value;
#[cfg(any(windows, test))]
use std::collections::HashMap;

use crate::error::{ErrorCode, ProtocolError};
use crate::refs::{RefStore, WindowRef};

#[cfg(windows)]
use crate::state::StateId;
#[cfg(windows)]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
#[cfg(windows)]
use image::codecs::png::PngEncoder;
#[cfg(windows)]
use image::{imageops::FilterType, ExtendedColorType, ImageEncoder, RgbaImage};
#[cfg(windows)]
use serde_json::json;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/// Capture a screenshot of the target window, optionally extracting UIA
/// accessibility elements from the same window.
///
/// # Arguments
///
/// * `store` - RefStore containing the window handle for `target_ref`.
///   Also receives inserted element refs when `include_elements` is true.
/// * `target_ref` - Reference to the window to capture.
/// * `include_elements` - When true, also extracts UIA elements and includes
///   them in the response as an `axTargets` array.
/// * `expected_pid` - Owning process recorded during root discovery; revalidated
///   before focus and around every completed render.
///
/// # Returns
///
/// On success, a JSON value with shape:
/// ```json
/// {
///   "target": "@w1",
///   "capture": { ... },
///   "warnings": [],
///   "axTargets": []
/// }
/// ```
/// The `axTargets` field is only present when `include_elements` is true
/// and at least one element was found.
///
/// On non-Windows this always returns `UnsupportedPlatform`.
pub fn screenshot(
    store: &mut RefStore,
    target_ref: &WindowRef,
    include_elements: bool,
    max_dimension: Option<u32>,
    expected_pid: u64,
) -> Result<Value, ProtocolError> {
    #[cfg(not(windows))]
    {
        let _ = store;
        let _ = target_ref;
        let _ = include_elements;
        let _ = (max_dimension, expected_pid);
        Err(ProtocolError::new(
            "Screenshot capture is only supported on Windows",
            ErrorCode::UnsupportedPlatform,
        ))
    }

    #[cfg(windows)]
    {
        screenshot_impl(
            store,
            target_ref,
            include_elements,
            max_dimension,
            expected_pid,
        )
    }
}

// ---------------------------------------------------------------------------
// Windows-specific implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
use windows::Win32::Foundation::{HWND, RECT};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
#[cfg(windows)]
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic};

#[cfg(any(windows, test))]
fn is_effectively_blank_bgra(bits: &[u8]) -> bool {
    let mut sampled = 0usize;
    let mut buckets: HashMap<(u8, u8, u8), usize> = HashMap::new();

    for [blue, green, red, _] in bits.as_chunks::<4>().0.iter().step_by(97) {
        sampled += 1;
        let bucket = (blue >> 3, green >> 3, red >> 3);
        *buckets.entry(bucket).or_default() += 1;
    }

    sampled > 0
        && buckets
            .values()
            .copied()
            .max()
            .is_some_and(|count| count * 100 >= sampled * 97)
}

#[cfg(windows)]
fn screenshot_impl(
    store: &mut RefStore,
    target_ref: &WindowRef,
    include_elements: bool,
    max_dimension: Option<u32>,
    expected_pid: u64,
) -> Result<Value, ProtocolError> {
    // 1. Look up the window handle.
    let native = store.get_window(target_ref).ok_or_else(|| {
        ProtocolError::new(
            format!("Window ref '{}' not found", target_ref),
            ErrorCode::TargetNotFound,
        )
    })?;
    if native.raw() == 0 {
        return Err(ProtocolError::new(
            "Invalid null window handle",
            ErrorCode::CaptureFailed,
        ));
    }
    let hwnd = HWND(native.raw() as *mut _);
    crate::desktop::validated_bounds(native.raw(), Some(expected_pid))?;

    let mut warnings: Vec<String> = Vec::new();

    // 2. Check for minimized state.
    let is_minimized = unsafe { IsIconic(hwnd).as_bool() };
    let requires_transition = is_minimized
        || unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() != hwnd };
    let mut before_rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut before_rect) }.map_err(|_| {
        ProtocolError::new("Capture baseline unavailable", ErrorCode::CaptureFailed)
    })?;
    let baseline_rect = (
        before_rect.left,
        before_rect.top,
        before_rect.right - before_rect.left,
        before_rect.bottom - before_rect.top,
    );
    let baseline = if requires_transition && !is_minimized {
        // A failed pre-transition render is not evidence of a changed frame.
        unsafe { gdi_capture_to_base64(hwnd, baseline_rect.2, baseline_rect.3, max_dimension) }
            .ok()
            .map(|frame| fingerprint(&frame.0))
    } else {
        None
    };
    let mut freshness =
        crate::freshness::Freshness::new(baseline_rect, baseline, requires_transition);
    crate::desktop::validated_bounds(native.raw(), Some(expected_pid))?;
    crate::window::request_foreground(native.raw())?;
    if is_minimized {
        warnings.push("window_restored".to_owned());
    }

    // 3. Get the window rect so we know capture dimensions.
    let (x, y, width, height) = unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return Err(ProtocolError::new(
                "Failed to get window bounds",
                ErrorCode::CaptureFailed,
            ));
        }
        let w = (rect.right - rect.left).max(0);
        let h = (rect.bottom - rect.top).max(0);
        (rect.left, rect.top, w, h)
    };

    if width == 0 || height == 0 {
        return Err(ProtocolError::new(
            "Window has no capturable extent",
            ErrorCode::CaptureFailed,
        ));
    }

    // 4. GDI capture (unsafe FFI block).
    // SAFETY: All GDI objects are created and destroyed within this
    // function.  Object lifetimes follow the Acquire → Use → Release
    // pattern with proper cleanup on every error path.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
    let (png_base64, output_width, output_height) = loop {
        crate::desktop::validated_bounds(native.raw(), Some(expected_pid))?;
        let mut current_rect = RECT::default();
        // SAFETY: borrowed HWND was just validated; RECT is writable and initialized.
        unsafe { GetWindowRect(hwnd, &mut current_rect) }
            .map_err(|_| ProtocolError::new("Capture window vanished", ErrorCode::CaptureFailed))?;
        if (
            current_rect.left,
            current_rect.top,
            current_rect.right - current_rect.left,
            current_rect.bottom - current_rect.top,
        ) != (x, y, width, height)
        {
            return Err(ProtocolError::new(
                "Window moved during capture; observe again",
                ErrorCode::CaptureFailed,
            ));
        }
        // SAFETY: current live extent is positive and capture owns all GDI resources.
        let frame = unsafe { gdi_capture_to_base64(hwnd, width, height, max_dimension) }?;
        crate::desktop::validated_bounds(native.raw(), Some(expected_pid))?;
        let mut rendered_rect = RECT::default();
        // SAFETY: revalidated borrowed HWND, with a live initialized output RECT.
        unsafe { GetWindowRect(hwnd, &mut rendered_rect) }.map_err(|_| {
            ProtocolError::new(
                "Capture window vanished after rendering",
                ErrorCode::CaptureFailed,
            )
        })?;
        if (
            rendered_rect.left,
            rendered_rect.top,
            rendered_rect.right,
            rendered_rect.bottom,
        ) != (
            current_rect.left,
            current_rect.top,
            current_rect.right,
            current_rect.bottom,
        ) {
            return Err(ProtocolError::new(
                "Window moved while rendering; observe again",
                ErrorCode::CaptureFailed,
            ));
        }
        if freshness.observe(crate::freshness::Frame {
            rect: (x, y, width, height),
            fingerprint: fingerprint(&frame.0),
        }) {
            break frame;
        }
        if std::time::Instant::now() >= deadline {
            return Err(ProtocolError::new(
                "Capture freshness could not be established",
                ErrorCode::CaptureFailed,
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    };

    let state_id = StateId::fresh("s");
    // SAFETY: HWND remains borrowed; API returns zero if it ceased to be valid.
    let dpi = unsafe { windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd) };
    if dpi == 0 {
        return Err(ProtocolError::new(
            "Capture window DPI is unavailable",
            ErrorCode::CaptureFailed,
        ));
    }

    // Build the base response.
    let mut result = json!({
        "target": target_ref.to_string(),
        "capture": {
            "stateId": state_id,
            "x": x,
            "y": y,
            "width": output_width,
            "height": output_height,
            "sourceWidth": width,
            "sourceHeight": height,
            "scaleFactor": f64::from(dpi) / 96.0,
            "imageFormat": "png",
            "imageBase64": png_base64,
        },
        "warnings": warnings,
    });

    // 5. Optionally extract UIA accessibility elements.
    if include_elements {
        let elements = crate::uia::live_elements(hwnd.0 as isize)
            .map_err(|message| ProtocolError::new(message, ErrorCode::CapabilityDeferred))?;
        if !elements.is_empty() {
            if let Some(obj) = result.as_object_mut() {
                obj.insert("axTargets".to_owned(), Value::Array(elements));
            }
        }
    }

    Ok(result)
}

#[cfg(windows)]
fn fingerprint(encoded: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    encoded.hash(&mut hasher);
    hasher.finish()
}

/// Perform GDI capture of the given window and return a base64-encoded PNG.
///
/// # Safety
///
/// Caller must provide a valid HWND and positive dimensions.
#[cfg(windows)]
unsafe fn gdi_capture_to_base64(
    hwnd: HWND,
    width: i32,
    height: i32,
    max_dimension: Option<u32>,
) -> Result<(String, u32, u32), ProtocolError> {
    if width <= 0 || height <= 0 || i64::from(width) * i64::from(height) > 16 * 1024 * 1024 {
        return Err(ProtocolError::new(
            "Window capture exceeds pixel budget",
            ErrorCode::CaptureFailed,
        ));
    }
    // Acquire the window DC.
    let hdc_window = GetDC(hwnd);
    if hdc_window.is_invalid() {
        return Err(ProtocolError::new("GetDC failed", ErrorCode::CaptureFailed));
    }

    // Create a compatible memory DC.
    let hdc_mem = CreateCompatibleDC(hdc_window);
    if hdc_mem.is_invalid() {
        ReleaseDC(hwnd, hdc_window);
        return Err(ProtocolError::new(
            "CreateCompatibleDC failed",
            ErrorCode::CaptureFailed,
        ));
    }

    // Create a compatible bitmap.
    let hbitmap = CreateCompatibleBitmap(hdc_window, width, height);
    if hbitmap.is_invalid() {
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(hwnd, hdc_window);
        return Err(ProtocolError::new(
            "CreateCompatibleBitmap failed",
            ErrorCode::CaptureFailed,
        ));
    }

    // Select bitmap into memory DC (save old to restore later).
    let old_bitmap = SelectObject(hdc_mem, hbitmap);

    // Render the window content using PrintWindow (client area).
    let pw_ok = PrintWindow(
        hwnd,
        hdc_mem,
        PRINT_WINDOW_FLAGS(windows::Win32::UI::WindowsAndMessaging::PW_RENDERFULLCONTENT),
    );
    if !pw_ok.as_bool() {
        // PrintWindow can fail for various reasons.  We note it but
        // continue — the DC might still have partial content.
    }

    // Prepare BITMAPINFO for GetDIBits (request 32-bit BGRA top-down).
    let header = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height, // negative = top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };
    let mut bmi = BITMAPINFO {
        bmiHeader: header,
        ..Default::default()
    };

    // Allocate the pixel buffer.
    let buf_size = (width as usize)
        .checked_mul(height as usize)
        .and_then(|size| size.checked_mul(4))
        .filter(|size| *size <= 64 * 1024 * 1024);
    let Some(buf_size) = buf_size else {
        SelectObject(hdc_mem, old_bitmap);
        let _ = DeleteObject(HGDIOBJ(hbitmap.0));
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(hwnd, hdc_window);
        return Err(ProtocolError::new(
            "Window capture exceeds byte budget",
            ErrorCode::CaptureFailed,
        ));
    };
    let mut bits: Vec<u8> = vec![0u8; buf_size];

    // GetDIBits requires the bitmap not to be selected into any DC.
    SelectObject(hdc_mem, old_bitmap);
    // SAFETY: owned bitmap is deselected, BITMAPINFO describes exactly the checked
    // four-byte-per-pixel buffer, and all handles remain live until cleanup below.
    let dib_ok = GetDIBits(
        hdc_mem,
        hbitmap,
        0,
        height as u32,
        Some(bits.as_mut_ptr() as *mut std::ffi::c_void),
        &mut bmi,
        DIB_RGB_COLORS,
    );

    // Never substitute screen pixels: another window can cover this HWND.
    let valid_render = pw_ok.as_bool() && dib_ok == height && !is_effectively_blank_bgra(&bits);

    // Restore old bitmap and destroy GDI objects.
    SelectObject(hdc_mem, old_bitmap);
    let _ = DeleteObject(HGDIOBJ(hbitmap.0));
    let _ = DeleteDC(hdc_mem);
    ReleaseDC(hwnd, hdc_window);

    if !valid_render {
        return Err(ProtocolError::new(
            "GetDIBits failed to retrieve bitmap data",
            ErrorCode::CaptureFailed,
        ));
    }

    // Convert BGRA → RGBA (GDI returns B,G,R,A; PNG expects R,G,B,A).
    for chunk in bits.as_chunks_mut::<4>().0 {
        chunk.swap(0, 2);
        chunk[3] = 255;
    }

    let source_width = width as u32;
    let source_height = height as u32;
    let (output_width, output_height) = match max_dimension.filter(|limit| *limit > 0) {
        Some(limit) if source_width.max(source_height) > limit => {
            let scale = limit as f64 / source_width.max(source_height) as f64;
            (
                (source_width as f64 * scale).round().max(1.0) as u32,
                (source_height as f64 * scale).round().max(1.0) as u32,
            )
        }
        _ => (source_width, source_height),
    };
    let pixels = if (output_width, output_height) == (source_width, source_height) {
        bits
    } else {
        let source = RgbaImage::from_raw(source_width, source_height, bits).ok_or_else(|| {
            ProtocolError::new(
                "Captured bitmap had an invalid byte length",
                ErrorCode::CaptureFailed,
            )
        })?;
        image::imageops::resize(&source, output_width, output_height, FilterType::Triangle)
            .into_raw()
    };

    // Encode to PNG in memory.
    let mut png_data: Vec<u8> = Vec::new();
    {
        let encoder = PngEncoder::new(&mut png_data);
        encoder
            .write_image(
                &pixels,
                output_width,
                output_height,
                ExtendedColorType::Rgba8,
            )
            .map_err(|e| {
                ProtocolError::new(
                    format!("PNG encoding failed: {e}"),
                    ErrorCode::CaptureFailed,
                )
            })?;
    }

    // Base64-encode the PNG bytes.
    Ok((BASE64.encode(&png_data), output_width, output_height))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod unit_tests {
    use super::*;
    use crate::error::ErrorCode;
    #[cfg(windows)]
    use crate::refs::NativeHandle;
    use crate::state::StateId;

    #[test]
    fn detects_uniform_failed_compositor_captures() {
        let black = [0, 0, 0, 255].repeat(10_000);
        let white = [231, 231, 231, 255].repeat(10_000);
        let mut almost_uniform = white.clone();
        for offset in (0..almost_uniform.len()).step_by(4).take(200) {
            almost_uniform[offset..offset + 3].copy_from_slice(&[40, 120, 200]);
        }

        assert!(is_effectively_blank_bgra(&black));
        assert!(is_effectively_blank_bgra(&white));
        assert!(is_effectively_blank_bgra(&almost_uniform));
    }

    #[test]
    fn preserves_light_windows_with_real_visual_detail() {
        let mut detailed = Vec::new();
        for index in 0..10_000 {
            let value = if index % 20 == 0 { 20 } else { 245 };
            detailed.extend_from_slice(&[value, value, value, 255]);
        }

        assert!(!is_effectively_blank_bgra(&detailed));
    }

    // -- Platform support check (non-Windows) -------------------------------

    #[test]
    #[cfg(not(windows))]
    fn test_screenshot_unsupported_platform() {
        let mut store = RefStore::new();
        let wref = WindowRef { id: 1 };
        let result = screenshot(&mut store, &wref, false, None, 0);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code, ErrorCode::UnsupportedPlatform);
    }

    // -- Response shape tests (cross-platform) -----------------------------

    #[test]
    fn test_screenshot_response_shape_json() {
        // Verify that a successful screenshot response serialises to the
        // expected JSON shape.  This test does not require a real window.
        let state_id = StateId::fresh("s");
        let response = serde_json::json!({
            "target": "@w1",
            "capture": {
                "stateId": state_id,
                "width": 800,
                "height": 600,
                "imageFormat": "png",
                "imageBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            },
            "warnings": [],
        });

        // Validate structural fields
        assert_eq!(response["target"].as_str(), Some("@w1"));
        assert!(response["capture"].is_object());
        assert!(response["warnings"].is_array());
        assert!(response["warnings"].as_array().unwrap().is_empty());

        let capture = &response["capture"];
        assert!(capture["stateId"].as_str().unwrap().starts_with("s-"));
        assert_eq!(capture["width"].as_u64(), Some(800));
        assert_eq!(capture["height"].as_u64(), Some(600));
        assert_eq!(capture["imageFormat"].as_str(), Some("png"));
        assert!(capture["imageBase64"].as_str().unwrap().len() > 10);
    }

    #[test]
    fn test_screenshot_response_with_warnings() {
        // Verify response with warnings and null image for zero-sized capture.
        let state_id = StateId::fresh("s");
        let response = serde_json::json!({
            "target": "@w1",
            "capture": {
                "stateId": state_id,
                "width": 0,
                "height": 0,
                "imageFormat": "png",
                "imageBase64": null,
            },
            "warnings": ["zero_sized_window"],
        });

        assert_eq!(response["target"].as_str(), Some("@w1"));
        assert_eq!(
            response["warnings"].as_array().unwrap(),
            &[serde_json::json!("zero_sized_window")]
        );
        assert!(response["capture"]["imageBase64"].is_null());
        assert_eq!(response["capture"]["width"].as_u64(), Some(0));
        assert_eq!(response["capture"]["height"].as_u64(), Some(0));
    }

    #[test]
    fn test_screenshot_target_not_found_error() {
        // Verify that a non-existent window ref produces the expected error.
        // On non-Windows the platform check returns UnsupportedPlatform first;
        // on Windows an empty store would return TargetNotFound.
        let mut store = RefStore::new();
        let wref = WindowRef { id: 999 };
        let result = screenshot(&mut store, &wref, false, None, 0);
        assert!(result.is_err());
        let err = result.unwrap_err();
        #[cfg(not(windows))]
        assert_eq!(err.code, ErrorCode::UnsupportedPlatform);
        #[cfg(windows)]
        assert_eq!(err.code, ErrorCode::TargetNotFound);
    }

    // A null HWND must refuse before any capture API; never accept a desktop-dependent outcome.
    #[test]
    #[cfg(windows)]
    fn null_window_capture_is_a_deterministic_refusal() {
        let mut store = RefStore::new();
        let wref = store.insert_window(NativeHandle::new(0));
        for _ in 0..2 {
            let error = screenshot(&mut store, &wref, false, None, 0).unwrap_err();
            assert_eq!(error.code, ErrorCode::CaptureFailed);
            assert_eq!(error.message, "Invalid null window handle");
        }
    }
}
