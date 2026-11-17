//! Read-only UIA (UI Automation) element extraction for Windows.
//!
//! On Windows, uses the `windows` crate to walk the UIA accessibility tree
//! of a given top-level window and extract semantic elements with their
//! properties.  On non-Windows platforms all entry points are stubbed out
//! and return empty results.
//!
//! UIA element extraction for model-visible outlines and element metadata.

use serde_json::Value;

use crate::refs::RefStore;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/// Extract UIA accessible elements from the window identified by `hwnd`.
///
/// Returns a `Vec` of JSON objects, each with shape:
/// ```json
/// {
///   "ref": "@e1",
///   "role": "edit",
///   "label": "Address bar",
///   "automationId": "1001",
///   "className": "Edit",
///   "bounds": { "x": 0, "y": 0, "width": 100, "height": 20 },
///   "capabilities": { "isEnabled": true, "isOffscreen": false }
/// }
/// ```
///
/// On non-Windows this always returns an empty `Vec`.
pub fn extract_elements(store: &mut RefStore, hwnd: isize) -> Vec<Value> {
    #[cfg(not(windows))]
    {
        let _ = store;
        let _ = hwnd;
        Vec::new()
    }

    #[cfg(windows)]
    {
        match uia_extract(store, hwnd) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[uia] WARN extraction skipped: {e}");
                Vec::new()
            }
        }
    }
}

/// Extract the subtree rooted at a previously observed element.
pub fn extract_elements_from(
    store: &mut RefStore,
    hwnd: isize,
    runtime_id: &[i32],
    automation_id: &str,
) -> Result<Vec<Value>, String> {
    #[cfg(not(windows))]
    {
        let _ = (store, hwnd, runtime_id, automation_id);
        Ok(Vec::new())
    }
    #[cfg(windows)]
    {
        native::uia_extract_from(store, hwnd, runtime_id, automation_id)
    }
}

// ---------------------------------------------------------------------------
// UIA control type → semantic role mapping
//
// These constants and the mapping function are always compiled because
// they are exercised by cross-platform unit tests, but on non-Windows the
// compiler flags them as dead code since they are only called from the
// `#[cfg(windows)] native` module.  We suppress the lint for that case.
// ---------------------------------------------------------------------------

#[cfg_attr(not(windows), allow(dead_code))]
const UIA_WINDOW_CONTROL: u32 = 50032;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_PANE_CONTROL: u32 = 50033;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_DOCUMENT_CONTROL: u32 = 50030;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_EDIT_CONTROL: u32 = 50004;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_BUTTON_CONTROL: u32 = 50000;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_CHECKBOX_CONTROL: u32 = 50002;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_RADIOBUTTON_CONTROL: u32 = 50007;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_COMBOBOX_CONTROL: u32 = 50003;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_LIST_CONTROL: u32 = 50008;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_LISTITEM_CONTROL: u32 = 50009;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TREE_CONTROL: u32 = 50020;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TREEITEM_CONTROL: u32 = 50021;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_MENUITEM_CONTROL: u32 = 50010;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TEXT_CONTROL: u32 = 50019;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_HYPERLINK_CONTROL: u32 = 50005;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TAB_CONTROL: u32 = 50018;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TABITEM_CONTROL: u32 = 50022;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_HEADER_CONTROL: u32 = 50034;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_HEADERITEM_CONTROL: u32 = 50035;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TABLE_CONTROL: u32 = 50036;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_IMAGE_CONTROL: u32 = 50031;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_SLIDER_CONTROL: u32 = 50013;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_PROGRESSBAR_CONTROL: u32 = 50006;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TOOLBAR_CONTROL: u32 = 50016;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_STATUSBAR_CONTROL: u32 = 50014;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TOOLTIP_CONTROL: u32 = 50015;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_SCROLLBAR_CONTROL: u32 = 50011;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_GROUP_CONTROL: u32 = 50026;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_SEPARATOR_CONTROL: u32 = 50039;

/// Map a UIA control type ID to a semantic role string.
///
/// Returns `"unknown"` for unrecognised control type IDs.
#[cfg_attr(not(windows), allow(dead_code))]
fn control_type_to_role(ctrl_type: u32) -> &'static str {
    match ctrl_type {
        UIA_WINDOW_CONTROL => "window",
        UIA_PANE_CONTROL => "pane",
        UIA_DOCUMENT_CONTROL => "document",
        UIA_EDIT_CONTROL => "edit",
        UIA_BUTTON_CONTROL => "button",
        UIA_CHECKBOX_CONTROL => "checkbox",
        UIA_RADIOBUTTON_CONTROL => "radio",
        UIA_COMBOBOX_CONTROL => "comboBox",
        UIA_LIST_CONTROL => "list",
        UIA_LISTITEM_CONTROL => "listItem",
        UIA_TREE_CONTROL => "tree",
        UIA_TREEITEM_CONTROL => "treeItem",
        UIA_MENUITEM_CONTROL => "menuItem",
        UIA_TEXT_CONTROL => "text",
        UIA_HYPERLINK_CONTROL => "link",
        UIA_TAB_CONTROL => "tab",
        UIA_TABITEM_CONTROL => "tabItem",
        UIA_HEADER_CONTROL => "header",
        UIA_HEADERITEM_CONTROL => "headerItem",
        UIA_TABLE_CONTROL => "table",
        UIA_IMAGE_CONTROL => "image",
        UIA_SLIDER_CONTROL => "slider",
        UIA_PROGRESSBAR_CONTROL => "progressBar",
        UIA_TOOLBAR_CONTROL => "toolBar",
        UIA_STATUSBAR_CONTROL => "statusBar",
        UIA_TOOLTIP_CONTROL => "toolTip",
        UIA_SCROLLBAR_CONTROL => "scrollBar",
        UIA_GROUP_CONTROL => "group",
        UIA_SEPARATOR_CONTROL => "separator",
        _ => "unknown",
    }
}

#[derive(Clone, Debug, Default)]
pub struct ElementAnnotationSignals {
    pub invoke: bool,
    pub toggle: bool,
    pub selection_item: bool,
    pub expand_collapse: bool,
    pub legacy_default_action: bool,
    pub value: bool,
    pub text: bool,
    pub value_read_only: Option<bool>,
}

pub fn annotation_can_press(signals: &ElementAnnotationSignals) -> bool {
    signals.invoke
        || signals.toggle
        || signals.selection_item
        || signals.expand_collapse
        || signals.legacy_default_action
}

pub fn annotation_can_set_text(signals: &ElementAnnotationSignals) -> bool {
    signals.value && !signals.value_read_only.unwrap_or(false) || signals.text
}

// ---------------------------------------------------------------------------
// Windows implementation  (windows crate)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod native {
    use serde_json::{json, Value};

    use super::{
        annotation_can_press, annotation_can_set_text, control_type_to_role,
        ElementAnnotationSignals,
    };
    use crate::refs::{NativeHandle, RefStore};
    use crate::{ErrorCode, ProtocolError};

    use windows::core::{Interface, BSTR};
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Ole::{
        SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
    };
    use windows::Win32::UI::Accessibility::*;

    const MAX_ELEMENTS: usize = 200;

    #[windows::core::implement(IUIAutomationEventHandler)]
    struct DiscoveryListener;

    impl IUIAutomationEventHandler_Impl for DiscoveryListener_Impl {
        fn HandleAutomationEvent(
            &self,
            _sender: Option<&IUIAutomationElement>,
            _event_id: UIA_EVENT_ID,
        ) -> windows::core::Result<()> {
            Ok(())
        }
    }

    /// Scoped assistive-client registration. It asks only this provider for
    /// events; unlike SPI_SETSCREENREADER it cannot alter owner-global state.
    struct DiscoveryLease {
        _registration: std::sync::MutexGuard<'static, ()>,
        uia: IUIAutomation,
        root: IUIAutomationElement,
        handler: IUIAutomationEventHandler,
    }

    impl DiscoveryLease {
        fn begin(uia: &IUIAutomation, root: &IUIAutomationElement) -> Result<Self, String> {
            // UIA forbids overlapping add/remove operations in one client.
            static REGISTRATION: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
            let registration = loop {
                match REGISTRATION.try_lock() {
                    Ok(guard) => break guard,
                    Err(std::sync::TryLockError::Poisoned(_)) => {
                        return Err("UIA discovery registration poisoned".to_owned())
                    }
                    Err(std::sync::TryLockError::WouldBlock)
                        if std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(std::time::Duration::from_millis(5))
                    }
                    Err(_) => return Err("UIA discovery registration busy".to_owned()),
                }
            };
            let handler: IUIAutomationEventHandler = DiscoveryListener.into();
            // SAFETY: COM is initialized; cloned interfaces keep root/handler alive
            // until the matching serialized removal in Drop.
            unsafe {
                uia.AddAutomationEventHandler(
                    UIA_LayoutInvalidatedEventId,
                    root,
                    TreeScope_Subtree,
                    None,
                    &handler,
                )
            }
            .map_err(|e| format!("Scoped UIA discovery registration: {e}"))?;
            Ok(Self {
                _registration: registration,
                uia: uia.clone(),
                root: root.clone(),
                handler,
            })
        }
    }

    impl Drop for DiscoveryLease {
        fn drop(&mut self) {
            // SAFETY: remove only the registration owned by this operation.
            let _ = unsafe {
                self.uia.RemoveAutomationEventHandler(
                    UIA_LayoutInvalidatedEventId,
                    &self.root,
                    &self.handler,
                )
            };
        }
    }

    /// Entry point called from the public stub on cfg(windows).
    pub fn uia_extract(store: &mut RefStore, hwnd: isize) -> Result<Vec<Value>, String> {
        crate::desktop::validated_bounds(hwnd, None).map_err(|error| error.to_string())?;
        let _com = ComGuard::new()?;
        let uia = automation()?;

        let root = unsafe {
            uia.ElementFromHandle(HWND(hwnd as *mut _))
                .map_err(|e| format!("ElementFromHandle: {e}"))?
        };

        extract_from_root(store, &uia, &root)
    }

    pub fn uia_extract_from(
        store: &mut RefStore,
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<Vec<Value>, String> {
        let (_com, uia, root) = resolve(hwnd, runtime_id_target, automation_id)?;
        extract_from_root(store, &uia, &root)
    }

    /// windows-rs represents an S_OK/null tree-walker result as Error::empty.
    /// Only that successful end-of-tree sentinel is optional; real provider
    /// failures must not silently turn a sparse extraction into a complete one.
    fn optional_element(
        result: windows::core::Result<IUIAutomationElement>,
    ) -> Result<Option<IUIAutomationElement>, String> {
        match result {
            Ok(element) => Ok(Some(element)),
            Err(error) if error.code().is_ok() => Ok(None),
            Err(error) => Err(format!("UIA tree-walker provider failure: {error}")),
        }
    }

    /// Walk one selected subtree, never an unbounded provider-side FindAll.
    fn bounded_elements(
        uia: &IUIAutomation,
        root: &IUIAutomationElement,
    ) -> Result<(Vec<IUIAutomationElement>, bool), String> {
        // SAFETY: caller owns initialized COM and live automation/root interfaces.
        let walker = unsafe { uia.RawViewWalker() }.map_err(|e| format!("RawViewWalker: {e}"))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
        let mut pending = std::collections::VecDeque::from([(root.clone(), 0usize)]);
        let mut found = Vec::new();
        let mut truncated = false;
        while let Some((element, depth)) = pending.pop_front() {
            if found.len() >= MAX_ELEMENTS || std::time::Instant::now() >= deadline {
                truncated = true;
                break;
            }
            found.push(element.clone());
            if depth >= 64 {
                truncated = true;
                continue;
            }
            // SAFETY: walker and element are owned COM interfaces on this thread;
            // a removed provider is reported as an HRESULT, never a raw pointer.
            let mut child = optional_element(unsafe { walker.GetFirstChildElement(&element) })?;
            while let Some(current) = child {
                if pending.len() + found.len() >= MAX_ELEMENTS
                    || std::time::Instant::now() >= deadline
                {
                    truncated = true;
                    break;
                }
                pending.push_back((current.clone(), depth + 1));
                // SAFETY: current is still owned; optional_element checks end/error.
                child = optional_element(unsafe { walker.GetNextSiblingElement(&current) })?;
            }
        }
        Ok((found, truncated))
    }

    fn extract_from_root(
        store: &mut RefStore,
        uia: &IUIAutomation,
        root: &IUIAutomationElement,
    ) -> Result<Vec<Value>, String> {
        let _discovery = DiscoveryLease::begin(uia, root)?;
        let (found, truncated) = bounded_elements(uia, root)?;
        // SAFETY: caller holds COM initialization and the automation interface.
        let walker = unsafe { uia.RawViewWalker() }.map_err(|e| format!("RawViewWalker: {e}"))?;
        let mut elements = Vec::with_capacity(found.len());
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
        let mut truncated = truncated;
        for element in found {
            if std::time::Instant::now() >= deadline {
                truncated = true;
                break;
            }
            // SAFETY: owned interfaces remain live; unavailable parents are omitted.
            let parent = match optional_element(unsafe { walker.GetParentElement(&element) })? {
                Some(parent) => runtime_id(&parent)?,
                None => Vec::new(),
            };
            let identity = runtime_id(&element)?;
            if let Some(value) = element_to_json(store, &element, parent, identity) {
                elements.push(value);
            }
        }
        if truncated {
            if let Some(root) = elements.first_mut() {
                root["truncated"] = json!(true);
            }
        }
        Ok(elements)
    }

    /// First-party UIA client activation scoped to the requested HWND. Raw-view
    /// traversal discovers provider labels excluded by control-view filtering.
    /// No SPI_SETSCREENREADER or other global owner setting is changed.
    fn automation() -> Result<IUIAutomation, String> {
        let uia: IUIAutomation2 =
            unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
                .map_err(|e| format!("CoCreateInstance IUIAutomation2: {e}"))?;
        unsafe {
            uia.SetConnectionTimeout(500)
                .map_err(|e| format!("ConnectionTimeout: {e}"))?;
            uia.SetTransactionTimeout(500)
                .map_err(|e| format!("TransactionTimeout: {e}"))?;
        }
        uia.cast().map_err(|e| format!("IUIAutomation: {e}"))
    }

    struct RuntimeArray(*mut SAFEARRAY);

    impl Drop for RuntimeArray {
        fn drop(&mut self) {
            // SAFETY: GetRuntimeId transfers this SAFEARRAY to the caller.
            let _ = unsafe { SafeArrayDestroy(self.0) };
        }
    }

    fn runtime_id(element: &IUIAutomationElement) -> Result<Vec<i32>, String> {
        // SAFETY: caller owns the live COM interface; the returned array is owned here.
        let array =
            // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
            unsafe { element.GetRuntimeId() }.map_err(|error| format!("GetRuntimeId: {error}"))?;
        if array.is_null() {
            return Err("GetRuntimeId returned null".to_owned());
        }
        let _owned = RuntimeArray(array);
        // SAFETY: array is nonnull, owned, and bounded before reading elements.
        let lower = unsafe { SafeArrayGetLBound(array, 1) }
            .map_err(|error| format!("RuntimeId lower bound: {error}"))?;
        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        let upper = unsafe { SafeArrayGetUBound(array, 1) }
            .map_err(|error| format!("RuntimeId upper bound: {error}"))?;
        let count = upper
            .checked_sub(lower)
            .and_then(|value| value.checked_add(1))
            .filter(|count| (1..=128).contains(count))
            .ok_or("Invalid RuntimeId length")?;
        let mut values = Vec::with_capacity(count as usize);
        for index in lower..=upper {
            let mut value = 0i32;
            // SAFETY: index is in checked bounds and destination is one writable i32.
            unsafe { SafeArrayGetElement(array, &index, (&mut value as *mut i32).cast()) }
                .map_err(|error| format!("RuntimeId element: {error}"))?;
            values.push(value);
        }
        Ok(values)
    }

    /// Convert a single UIA element to its JSON representation.
    ///
    /// Returns `None` for elements that are offscreen, zero-sized, or
    /// otherwise uninteresting.
    fn element_to_json(
        store: &mut RefStore,
        element: &IUIAutomationElement,
        parent_runtime_id: Vec<i32>,
        runtime_id: Vec<i32>,
    ) -> Option<Value> {
        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        let ctrl_type = unsafe { element.CurrentControlType().ok()? };
        let role = control_type_to_role(ctrl_type.0 as u32);

        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        let name = unsafe { element.CurrentName().unwrap_or_default().to_string() };
        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        let automation_id = unsafe {
            element
                .CurrentAutomationId()
                .unwrap_or_default()
                .to_string()
        };
        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        let class_name = unsafe { element.CurrentClassName().unwrap_or_default().to_string() };

        // Bounding rectangle.
        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        let rect = unsafe { element.CurrentBoundingRectangle().ok()? };

        // Skip invisible / offscreen elements.
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w <= 0 || h <= 0 {
            return None;
        }

        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        let is_offscreen = unsafe {
            element
                .CurrentIsOffscreen()
                .map(|value| value.as_bool())
                .unwrap_or(true)
        };
        if is_offscreen {
            return None;
        }

        // Capabilities.
        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        let is_enabled = unsafe {
            element
                .CurrentIsEnabled()
                .map(|value| value.as_bool())
                .unwrap_or(true)
        };
        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        let is_keyboard_focusable = unsafe {
            element
                .CurrentIsKeyboardFocusable()
                .map(|value| value.as_bool())
                .unwrap_or(false)
        };
        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        let is_password = unsafe {
            element
                .CurrentIsPassword()
                .map(|value| value.as_bool())
                .unwrap_or(false)
        };
        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        let value_pattern = unsafe {
            element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .ok()
        };
        let value = value_pattern
            .as_ref()
            // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
            .and_then(|pattern| unsafe { pattern.CurrentValue().ok() })
            .map(|value| value.to_string())
            .unwrap_or_default();
        let value_read_only = value_pattern
            .as_ref()
            // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
            .and_then(|pattern| unsafe { pattern.CurrentIsReadOnly().ok() })
            .map(|read_only| read_only.as_bool());
        let signals = ElementAnnotationSignals {
            invoke: pattern_available(element, UIA_IsInvokePatternAvailablePropertyId),
            toggle: pattern_available(element, UIA_IsTogglePatternAvailablePropertyId),
            selection_item: pattern_available(
                element,
                UIA_IsSelectionItemPatternAvailablePropertyId,
            ),
            expand_collapse: pattern_available(
                element,
                UIA_IsExpandCollapsePatternAvailablePropertyId,
            ),
            legacy_default_action: legacy_default_action_available(element),
            value: pattern_available(element, UIA_IsValuePatternAvailablePropertyId),
            text: pattern_available(element, UIA_IsTextPatternAvailablePropertyId),
            value_read_only,
        };
        let can_press = annotation_can_press(&signals);
        let can_set_value = annotation_can_set_text(&signals);
        let can_scroll = pattern_available(element, UIA_IsScrollPatternAvailablePropertyId);

        let eref = store.insert_element(NativeHandle::new(0));

        Some(json!({
            "ref": eref.to_string(),
            "role": role,
            "label": name,
            "automationId": automation_id,
            "runtimeId": runtime_id,
            "parentRuntimeId": parent_runtime_id,
            "className": class_name,
            "value": value,
            "isPassword": is_password,
            "bounds": {
                "x": rect.left,
                "y": rect.top,
                "width": w,
                "height": h,
            },
            "capabilities": {
                "isEnabled": is_enabled,
                "isOffscreen": is_offscreen,
                "isKeyboardFocusable": is_keyboard_focusable,
                "canInvoke": signals.invoke,
                "canPress": can_press,
                "canSetValue": can_set_value,
                "canScroll": can_scroll,
            },
        }))
    }

    pub fn read_live_text(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<String, String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        if unsafe { element.CurrentIsPassword() }
            .map_err(|e| format!("CurrentIsPassword: {e}"))?
            .as_bool()
        {
            return Err("Secure text is unreadable".to_owned());
        }
        Ok(read_text_from_element(&element))
    }

    pub fn live_elements(hwnd: isize) -> Result<Vec<Value>, String> {
        let mut store = RefStore::new();
        uia_extract(&mut store, hwnd)
    }

    pub struct ElementSnapshot {
        pub rect: (f64, f64, f64, f64),
        pub runtime_id: Vec<i32>,
    }

    pub enum PressResult {
        Invoked,
        Toggled(bool),
        Selected(bool),
        Expanded,
        LegacyDefaultAction,
        NoPattern,
    }

    pub enum SetTextResult {
        Set { value: String },
        NoPattern,
    }

    pub enum ScrollResult {
        Scrolled,
        NoPattern,
    }

    pub fn snapshot(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<ElementSnapshot, String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        ensure_actionable(&element)?;
        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        let rect = unsafe {
            element
                .CurrentBoundingRectangle()
                .map_err(|e| format!("CurrentBoundingRectangle: {e}"))?
        };
        Ok(ElementSnapshot {
            rect: (
                f64::from(rect.left),
                f64::from(rect.top),
                f64::from(rect.right - rect.left),
                f64::from(rect.bottom - rect.top),
            ),
            runtime_id: runtime_id(&element)?,
        })
    }

    pub fn press(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<PressResult, ProtocolError> {
        let (_com, _uia, element) =
            resolve(hwnd, runtime_id_target, automation_id).map_err(before_delivery)?;
        ensure_actionable(&element).map_err(before_delivery)?;
        if let Some(pattern) = probe_pattern::<IUIAutomationInvokePattern>(
            &element,
            UIA_InvokePatternId,
            UIA_IsInvokePatternAvailablePropertyId,
        )? {
            // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
            unsafe {
                pattern.Invoke().map_err(|e| after_delivery("Invoke", e))?;
            }
            return Ok(PressResult::Invoked);
        }
        if let Some(pattern) = probe_pattern::<IUIAutomationTogglePattern>(
            &element,
            UIA_TogglePatternId,
            UIA_IsTogglePatternAvailablePropertyId,
        )? {
            // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
            unsafe {
                pattern.Toggle().map_err(|e| after_delivery("Toggle", e))?;
            }
            // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
            let state = unsafe {
                pattern
                    .CurrentToggleState()
                    .map_err(|e| after_delivery("Toggle read-back", e))?
                    .0
                    != 0
            };
            return Ok(PressResult::Toggled(state));
        }
        if let Some(pattern) = probe_pattern::<IUIAutomationSelectionItemPattern>(
            &element,
            UIA_SelectionItemPatternId,
            UIA_IsSelectionItemPatternAvailablePropertyId,
        )? {
            // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
            unsafe {
                pattern.Select().map_err(|e| after_delivery("Select", e))?;
            }
            // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
            let selected = unsafe {
                pattern
                    .CurrentIsSelected()
                    .map_err(|e| after_delivery("Select read-back", e))?
                    .as_bool()
            };
            return Ok(PressResult::Selected(selected));
        }
        if let Some(pattern) = probe_pattern::<IUIAutomationExpandCollapsePattern>(
            &element,
            UIA_ExpandCollapsePatternId,
            UIA_IsExpandCollapsePatternAvailablePropertyId,
        )? {
            // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
            unsafe {
                pattern.Expand().map_err(|e| after_delivery("Expand", e))?;
            }
            return Ok(PressResult::Expanded);
        }
        if let Some(pattern) = probe_pattern::<IUIAutomationLegacyIAccessiblePattern>(
            &element,
            UIA_LegacyIAccessiblePatternId,
            UIA_IsLegacyIAccessiblePatternAvailablePropertyId,
        )? {
            // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
            let default_action = unsafe {
                pattern
                    .CurrentDefaultAction()
                    .map_err(|error| before_delivery(format!("CurrentDefaultAction: {error}")))?
                    .to_string()
            };
            if !default_action.trim().is_empty() {
                // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
                unsafe {
                    pattern
                        .DoDefaultAction()
                        .map_err(|e| after_delivery("DoDefaultAction", e))?;
                }
                return Ok(PressResult::LegacyDefaultAction);
            }
        }
        Ok(PressResult::NoPattern)
    }

    /// Pattern absence is a successful false capability query, not an arbitrary
    /// provider error. Never turn denied/stale/failed probes into raw input.
    fn probe_pattern<T: Interface>(
        element: &IUIAutomationElement,
        pattern_id: UIA_PATTERN_ID,
        availability: UIA_PROPERTY_ID,
    ) -> Result<Option<T>, ProtocolError> {
        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        let value = unsafe { element.GetCurrentPropertyValue(availability) }
            .map_err(|error| before_delivery(format!("Pattern availability: {error}")))?;
        let available = bool::try_from(&value)
            .map_err(|error| before_delivery(format!("Pattern availability type: {error}")))?;
        if !available {
            return Ok(None);
        }
        // SAFETY: owned live COM interface on this COM-initialized thread; every HRESULT is propagated or refused.
        unsafe { element.GetCurrentPatternAs::<T>(pattern_id) }
            .map(Some)
            .map_err(|error| before_delivery(format!("Supported pattern query failed: {error}")))
    }

    /// Query failures refuse safely; no mutating pattern has been attempted.
    fn before_delivery(message: String) -> ProtocolError {
        let code = if message == "Element reference is stale" {
            ErrorCode::StaleRef
        } else {
            ErrorCode::InternalError
        };
        ProtocolError::new(message, code)
    }

    /// A failed mutation/read-back cannot acknowledge that nothing happened.
    fn after_delivery(operation: &str, error: impl std::fmt::Display) -> ProtocolError {
        ProtocolError::uncertain(
            format!("UIA '{operation}' outcome uncertain: {error}"),
            ErrorCode::CaptureFailed,
        )
    }

    fn ensure_actionable(element: &IUIAutomationElement) -> Result<(), String> {
        if !unsafe { element.CurrentIsEnabled() }
            .map_err(|e| format!("CurrentIsEnabled: {e}"))?
            .as_bool()
            || unsafe { element.CurrentIsOffscreen() }
                .map_err(|e| format!("CurrentIsOffscreen: {e}"))?
                .as_bool()
        {
            return Err("Element reference is disabled or offscreen".to_owned());
        }
        Ok(())
    }

    fn pattern_available(element: &IUIAutomationElement, property_id: UIA_PROPERTY_ID) -> bool {
        unsafe {
            element
                .GetCurrentPropertyValue(property_id)
                .ok()
                .and_then(|value| bool::try_from(&value).ok())
                .unwrap_or(false)
        }
    }

    fn legacy_default_action_available(element: &IUIAutomationElement) -> bool {
        if !pattern_available(element, UIA_IsLegacyIAccessiblePatternAvailablePropertyId) {
            return false;
        }
        unsafe {
            element
                .GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
                    UIA_LegacyIAccessiblePatternId,
                )
                .ok()
                .and_then(|pattern| pattern.CurrentDefaultAction().ok())
                .map(|action| !action.to_string().trim().is_empty())
                .unwrap_or(false)
        }
    }

    pub fn set_text(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
        text: &str,
    ) -> Result<SetTextResult, ProtocolError> {
        let (_com, _uia, element) =
            resolve(hwnd, runtime_id_target, automation_id).map_err(before_delivery)?;
        ensure_actionable(&element).map_err(before_delivery)?;
        if let Some(pattern) = probe_pattern::<IUIAutomationValuePattern>(
            &element,
            UIA_ValuePatternId,
            UIA_IsValuePatternAvailablePropertyId,
        )? {
            if unsafe { pattern.CurrentIsReadOnly() }
                .map_err(|error| before_delivery(format!("CurrentIsReadOnly: {error}")))?
                .as_bool()
            {
                return Err(ProtocolError::new(
                    "Target value is read-only",
                    ErrorCode::CoordinateBlocked,
                ));
            }
            let value = BSTR::from(text);
            unsafe {
                pattern
                    .SetValue(&value)
                    .map_err(|e| after_delivery("SetValue", e))?;
            }
            let value = unsafe {
                pattern
                    .CurrentValue()
                    .map_err(|e| after_delivery("SetValue read-back", e))?
                    .to_string()
            };
            return Ok(SetTextResult::Set { value });
        }
        Ok(SetTextResult::NoPattern)
    }

    pub fn focus(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<(), ProtocolError> {
        focus_for_input(hwnd, runtime_id_target, automation_id, false)
    }

    /// Focus and verify the exact control, preserving mutating-call/read-back uncertainty.
    pub fn focus_for_input(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
        for_text: bool,
    ) -> Result<(), ProtocolError> {
        let (_com, _uia, element) =
            resolve(hwnd, runtime_id_target, automation_id).map_err(before_delivery)?;
        focus_element(&element, for_text)
    }

    fn focus_element(element: &IUIAutomationElement, for_text: bool) -> Result<(), ProtocolError> {
        ensure_actionable(element).map_err(before_delivery)?;
        // SAFETY: all property calls use this thread's owned live COM interface.
        if for_text
            && unsafe { element.CurrentControlType() }
                .map_err(|error| before_delivery(format!("CurrentControlType: {error}")))?
                != UIA_EditControlTypeId
        {
            return Err(before_delivery(
                "Target is not a live editable control".to_owned(),
            ));
        }
        if !unsafe { element.CurrentIsKeyboardFocusable() }
            .map_err(|error| before_delivery(format!("CurrentIsKeyboardFocusable: {error}")))?
            .as_bool()
        {
            return Err(before_delivery(
                "Target does not accept keyboard focus".to_owned(),
            ));
        }
        crate::guard::deliver_focus(
            || {
                // SAFETY: caller validated the exact live target before this mutation.
                unsafe { element.SetFocus() }.map_err(|error| after_delivery("SetFocus", error))
            },
            || {
                // SAFETY: same owned COM element; a read-back failure is uncertain.
                unsafe { element.CurrentHasKeyboardFocus() }
                    .map(|value| value.as_bool())
                    .map_err(|error| after_delivery("SetFocus read-back", error))
            },
        )
    }

    pub fn scroll(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
        x: f64,
        y: f64,
    ) -> Result<ScrollResult, ProtocolError> {
        let (_com, _uia, element) =
            resolve(hwnd, runtime_id_target, automation_id).map_err(before_delivery)?;
        ensure_actionable(&element).map_err(before_delivery)?;
        if let Some(pattern) = probe_pattern::<IUIAutomationScrollPattern>(
            &element,
            UIA_ScrollPatternId,
            UIA_IsScrollPatternAvailablePropertyId,
        )? {
            let horizontal = if x > 0.0 {
                ScrollAmount_SmallIncrement
            } else if x < 0.0 {
                ScrollAmount_SmallDecrement
            } else {
                ScrollAmount_NoAmount
            };
            let vertical = if y > 0.0 {
                ScrollAmount_SmallIncrement
            } else if y < 0.0 {
                ScrollAmount_SmallDecrement
            } else {
                ScrollAmount_NoAmount
            };
            unsafe {
                pattern
                    .Scroll(horizontal, vertical)
                    .map_err(|e| after_delivery("Scroll", e))?;
            }
            return Ok(ScrollResult::Scrolled);
        }
        Ok(ScrollResult::NoPattern)
    }

    pub fn occlusion_ok(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
        x: f64,
        y: f64,
    ) -> Result<bool, ProtocolError> {
        let (_com, uia, target) =
            resolve(hwnd, runtime_id_target, automation_id).map_err(before_delivery)?;
        let hit = unsafe {
            uia.ElementFromPoint(POINT {
                x: x.round() as i32,
                y: y.round() as i32,
            })
            .map_err(|e| before_delivery(format!("ElementFromPoint: {e}")))?
        };
        let target_id = runtime_id(&target).map_err(before_delivery)?;
        let walker = unsafe {
            uia.ControlViewWalker()
                .map_err(|e| before_delivery(format!("ControlViewWalker: {e}")))?
        };
        crate::guard::hit_ancestry(
            &target_id,
            hit,
            |element| runtime_id(element).map_err(before_delivery),
            |element| {
                // SAFETY: owned walker/element; optional_element distinguishes null end from failure.
                optional_element(unsafe { walker.GetParentElement(element) })
                    .map_err(before_delivery)
            },
        )
    }

    fn resolve(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<(ComGuard, IUIAutomation, IUIAutomationElement), String> {
        crate::desktop::validated_bounds(hwnd, None).map_err(|error| error.to_string())?;
        if runtime_id_target.is_empty() {
            return Err("Element reference is stale".to_owned());
        }
        let com = ComGuard::new()?;
        let uia = automation()?;
        let root = unsafe {
            uia.ElementFromHandle(HWND(hwnd as *mut _))
                .map_err(|e| format!("ElementFromHandle: {e}"))?
        };
        let _discovery = DiscoveryLease::begin(&uia, &root)?;
        if runtime_id(&root)?.as_slice() == runtime_id_target {
            ensure_observed_automation_id(&root, automation_id)?;
            return Ok((com, uia, root));
        }
        // An AutomationId can be reused after destruction. Never substitute it
        // for the observed RuntimeId, even when only one matching node exists.
        let (found, _) = bounded_elements(&uia, &root)?;
        for element in found {
            if runtime_id(&element)?.as_slice() == runtime_id_target {
                ensure_observed_automation_id(&element, automation_id)?;
                return Ok((com, uia, element));
            }
        }
        Err("Element reference is stale".to_owned())
    }

    fn ensure_observed_automation_id(
        element: &IUIAutomationElement,
        observed: &str,
    ) -> Result<(), String> {
        // An observed ID is an additional constraint, never a locator fallback.
        if observed.is_empty() {
            return Ok(());
        }
        // SAFETY: the element is live and COM is initialized on this thread.
        let actual = unsafe { element.CurrentAutomationId() }
            .map_err(|error| format!("CurrentAutomationId: {error}"))?
            .to_string();
        if actual != observed {
            return Err("Element reference is stale".to_owned());
        }
        Ok(())
    }

    fn read_text_from_element(element: &IUIAutomationElement) -> String {
        if let Ok(pattern) =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }
        {
            if let Ok(range) = unsafe { pattern.DocumentRange() } {
                if let Ok(value) = unsafe { range.GetText(-1) } {
                    let text = value.to_string();
                    if !text.is_empty() {
                        return text;
                    }
                }
            }
        }
        if let Ok(pattern) =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
        {
            if let Ok(value) = unsafe { pattern.CurrentValue() } {
                let text = value.to_string();
                if !text.is_empty() {
                    return text;
                }
            }
        }
        unsafe { element.CurrentName().unwrap_or_default().to_string() }
    }

    // -----------------------------------------------------------------------
    // COM lifetime guard
    // -----------------------------------------------------------------------

    /// Calls `CoInitializeEx` on construction and `CoUninitialize` on drop.
    struct ComGuard;

    impl ComGuard {
        fn new() -> Result<Self, String> {
            // SAFETY: COM must be initialised for the calling thread before
            // any UIA calls.  S_OK (0) and S_FALSE (1) are both success
            // indicators; only a negative HRESULT means failure.
            let hr = unsafe { CoInitializeEx(Some(std::ptr::null()), COINIT_MULTITHREADED) };
            if hr.0 < 0 {
                return Err(format!("CoInitializeEx failed: {:#010x}", hr.0));
            }
            Ok(Self)
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            // SAFETY: each successful CoInitializeEx (including S_FALSE) must
            // be balanced with a CoUninitialize.
            unsafe {
                CoUninitialize();
            }
        }
    }
}

#[cfg(windows)]
pub use native::{
    focus, focus_for_input, live_elements, occlusion_ok, press, read_live_text, scroll, set_text,
    snapshot, uia_extract, ElementSnapshot, PressResult, ScrollResult, SetTextResult,
};

#[cfg(not(windows))]
#[derive(Clone, Debug)]
pub struct ElementSnapshot {
    pub rect: (f64, f64, f64, f64),
    pub runtime_id: Vec<i32>,
}
#[cfg(not(windows))]
pub enum PressResult {
    Invoked,
    Toggled(bool),
    Selected(bool),
    Expanded,
    LegacyDefaultAction,
    NoPattern,
}
#[cfg(not(windows))]
pub enum SetTextResult {
    Set { value: String },
    NoPattern,
}
#[cfg(not(windows))]
pub enum ScrollResult {
    Scrolled,
    NoPattern,
}
#[cfg(not(windows))]
pub fn read_live_text(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
) -> Result<String, String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn live_elements(_hwnd: isize) -> Result<Vec<Value>, String> {
    Ok(Vec::new())
}
#[cfg(not(windows))]
pub fn snapshot(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
) -> Result<ElementSnapshot, String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn press(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
) -> Result<PressResult, crate::ProtocolError> {
    Err(crate::ProtocolError::new(
        "UIA is only supported on Windows",
        crate::ErrorCode::UnsupportedPlatform,
    ))
}
#[cfg(not(windows))]
pub fn set_text(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
    _text: &str,
) -> Result<SetTextResult, crate::ProtocolError> {
    Err(crate::ProtocolError::new(
        "UIA is only supported on Windows",
        crate::ErrorCode::UnsupportedPlatform,
    ))
}
/// Verify the exact live target owns keyboard focus before physical key input.
#[cfg(not(windows))]
pub fn focus_for_input(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
    _for_text: bool,
) -> Result<(), crate::ProtocolError> {
    Err(crate::ProtocolError::new(
        "UIA is only supported on Windows",
        crate::ErrorCode::UnsupportedPlatform,
    ))
}
#[cfg(not(windows))]
pub fn focus(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
) -> Result<(), crate::ProtocolError> {
    Err(crate::ProtocolError::new(
        "UIA is only supported on Windows",
        crate::ErrorCode::UnsupportedPlatform,
    ))
}
#[cfg(not(windows))]
pub fn scroll(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
    _x: f64,
    _y: f64,
) -> Result<ScrollResult, crate::ProtocolError> {
    Err(crate::ProtocolError::new(
        "UIA is only supported on Windows",
        crate::ErrorCode::UnsupportedPlatform,
    ))
}
#[cfg(not(windows))]
pub fn occlusion_ok(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
    _x: f64,
    _y: f64,
) -> Result<bool, crate::ProtocolError> {
    Err(crate::ProtocolError::new(
        "UIA is only supported on Windows",
        crate::ErrorCode::UnsupportedPlatform,
    ))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod unit_tests {
    use super::*;
    use crate::refs::NativeHandle;
    use serde_json::json;

    // -- Platform support check (non-Windows) -------------------------------

    #[test]
    #[cfg(not(windows))]
    fn test_extract_elements_empty_on_non_windows() {
        let mut store = RefStore::new();
        let result = extract_elements(&mut store, 0);
        assert!(result.is_empty());
    }

    // -- Role mapping (cross-platform) --------------------------------------

    #[test]
    fn test_control_type_to_role_edit() {
        assert_eq!(control_type_to_role(50004), "edit");
    }

    #[test]
    fn test_control_type_to_role_button() {
        assert_eq!(control_type_to_role(50000), "button");
    }

    #[test]
    fn test_control_type_to_role_checkbox() {
        assert_eq!(control_type_to_role(50002), "checkbox");
    }

    #[test]
    fn test_control_type_to_role_radio() {
        assert_eq!(control_type_to_role(50007), "radio");
    }

    #[test]
    fn test_control_type_to_role_window() {
        assert_eq!(control_type_to_role(50032), "window");
    }

    #[test]
    fn test_control_type_to_role_pane() {
        assert_eq!(control_type_to_role(50033), "pane");
    }

    #[test]
    fn test_control_type_to_role_menu_item() {
        assert_eq!(control_type_to_role(50010), "menuItem");
    }

    #[test]
    fn test_control_type_to_role_list_item() {
        assert_eq!(control_type_to_role(50009), "listItem");
    }

    #[test]
    fn test_control_type_to_role_document() {
        assert_eq!(control_type_to_role(50030), "document");
    }

    #[test]
    fn test_control_type_to_role_unknown() {
        assert_eq!(control_type_to_role(99999), "unknown");
        assert_eq!(control_type_to_role(0), "unknown");
    }

    // -- Element JSON shape (cross-platform) --------------------------------

    #[test]
    fn test_element_json_shape() {
        let mut store = RefStore::new();
        let eref = store.insert_element(NativeHandle::new(0));
        let ref_str = eref.to_string();

        let element = json!({
            "ref": ref_str,
            "role": "edit",
            "label": "Test Label",
            "automationId": "1001",
            "runtimeId": [42, 7, 9],
            "className": "Edit",
            "bounds": {
                "x": 10,
                "y": 20,
                "width": 100,
                "height": 30,
            },
            "capabilities": {
                "isEnabled": true,
                "isOffscreen": false,
                "isKeyboardFocusable": true,
            },
        });

        assert_eq!(element["ref"].as_str(), Some("@e1"));
        assert_eq!(element["role"].as_str(), Some("edit"));
        assert_eq!(element["label"].as_str(), Some("Test Label"));
        assert_eq!(element["automationId"].as_str(), Some("1001"));
        let runtime_id = element["runtimeId"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_i64().unwrap() as i32)
            .collect::<Vec<_>>();
        assert_eq!(runtime_id, vec![42, 7, 9]);
        assert_eq!(element["className"].as_str(), Some("Edit"));
        assert!(element["bounds"].is_object());
        assert_eq!(element["bounds"]["x"], 10);
        assert_eq!(element["bounds"]["y"], 20);
        assert_eq!(element["bounds"]["width"], 100);
        assert_eq!(element["bounds"]["height"], 30);
        assert!(element["capabilities"].is_object());
        assert_eq!(element["capabilities"]["isEnabled"], true);
        assert_eq!(element["capabilities"]["isOffscreen"], false);
        assert_eq!(element["capabilities"]["isKeyboardFocusable"], true);
    }

    #[test]
    fn pressability_annotation_matrix_matches_grounding_ladder() {
        let base = ElementAnnotationSignals::default();
        assert!(!annotation_can_press(&base));

        let cases = [
            ElementAnnotationSignals {
                invoke: true,
                ..base.clone()
            },
            ElementAnnotationSignals {
                toggle: true,
                ..base.clone()
            },
            ElementAnnotationSignals {
                selection_item: true,
                ..base.clone()
            },
            ElementAnnotationSignals {
                expand_collapse: true,
                ..base.clone()
            },
            ElementAnnotationSignals {
                legacy_default_action: true,
                ..base.clone()
            },
        ];
        for signals in cases {
            assert!(annotation_can_press(&signals));
        }
    }

    #[test]
    fn text_editable_annotation_matrix_matches_set_text_grounding() {
        assert!(!annotation_can_set_text(
            &ElementAnnotationSignals::default()
        ));
        assert!(annotation_can_set_text(&ElementAnnotationSignals {
            value: true,
            value_read_only: Some(false),
            ..Default::default()
        }));
        assert!(!annotation_can_set_text(&ElementAnnotationSignals {
            value: true,
            value_read_only: Some(true),
            ..Default::default()
        }));
        assert!(annotation_can_set_text(&ElementAnnotationSignals {
            text: true,
            ..Default::default()
        }));
    }

    #[test]
    fn test_ax_targets_response_shape() {
        // Simulate the screenshot response with axTargets.
        let mut store = RefStore::new();
        let eref = store.insert_element(NativeHandle::new(0));
        let ref_str = eref.to_string();

        let response = json!({
            "target": "@w1",
            "capture": {
                "stateId": "s-0",
                "width": 800,
                "height": 600,
                "imageFormat": "png",
                "imageBase64": "dummy",
            },
            "axTargets": [
                {
                    "ref": ref_str,
                    "role": "edit",
                    "label": "Address bar",
                    "automationId": "1001",
                    "className": "Edit",
                    "bounds": { "x": 0, "y": 0, "width": 800, "height": 30 },
                    "capabilities": {
                        "isEnabled": true,
                        "isOffscreen": false,
                        "isKeyboardFocusable": true,
                    },
                }
            ],
            "warnings": [],
        });

        assert_eq!(response["target"].as_str(), Some("@w1"));
        assert!(response["capture"].is_object());
        assert!(response["warnings"].is_array());
        assert!(response["axTargets"].is_array());

        let targets = response["axTargets"].as_array().unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0]["ref"].as_str(), Some("@e1"));
        assert_eq!(targets[0]["role"].as_str(), Some("edit"));
    }
}
