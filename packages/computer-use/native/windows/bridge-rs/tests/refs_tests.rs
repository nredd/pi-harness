use windows_bridge::refs::{NativeHandle, RefStore};

// ---------------------------------------------------------------------------
// First ref assertions
// ---------------------------------------------------------------------------

#[test]
fn test_first_window_ref_is_w1() {
    let mut store = RefStore::new();
    let wref = store.insert_window(NativeHandle::new(0x1234), 0);
    assert_eq!(wref.to_string(), "@w1");
}

#[test]
fn test_first_element_ref_is_e1() {
    let mut store = RefStore::new();
    let eref = store.insert_element(NativeHandle::new(0x5678));
    assert_eq!(eref.to_string(), "@e1");
}

// ---------------------------------------------------------------------------
// Refs are state-scoped: independent stores reset counters
// ---------------------------------------------------------------------------

#[test]
fn test_refs_are_state_scoped() {
    let mut store1 = RefStore::new();
    let mut store2 = RefStore::new();

    let w1 = store1.insert_window(NativeHandle::new(1), 0);
    let e1 = store1.insert_element(NativeHandle::new(2));
    let w2 = store2.insert_window(NativeHandle::new(3), 0);
    let e2 = store2.insert_element(NativeHandle::new(4));

    assert_eq!(w1.to_string(), "@w1");
    assert_eq!(e1.to_string(), "@e1");
    // Second store starts fresh at 1
    assert_eq!(w2.to_string(), "@w1");
    assert_eq!(e2.to_string(), "@e1");
}

// ---------------------------------------------------------------------------
// Monotonically increasing refs within the same store
// ---------------------------------------------------------------------------

#[test]
fn test_window_refs_increment() {
    let mut store = RefStore::new();
    let w1 = store.insert_window(NativeHandle::new(10), 0);
    let w2 = store.insert_window(NativeHandle::new(20), 0);
    let w3 = store.insert_window(NativeHandle::new(30), 0);

    assert_eq!(w1.to_string(), "@w1");
    assert_eq!(w2.to_string(), "@w2");
    assert_eq!(w3.to_string(), "@w3");
}

#[test]
fn test_window_refs_are_per_instance_generation() {
    let mut store = RefStore::new();
    let first = store.insert_window(NativeHandle::new(10), 7);
    assert_eq!(store.insert_window(NativeHandle::new(10), 7), first);
    // A replacement reusing the HWND gets a new ref; the old one never denotes it.
    let replacement = store.insert_window(NativeHandle::new(10), 8);
    assert_ne!(replacement, first);
    assert_eq!(store.get_window(&first), Some(NativeHandle::new(10)));
    store.retain_window_refs([replacement.to_string().as_str()]);
    assert_eq!(store.get_window(&first), None);
    assert_eq!(store.insert_window(NativeHandle::new(10), 8), replacement);
}

#[test]
fn test_element_refs_increment() {
    let mut store = RefStore::new();
    let e1 = store.insert_element(NativeHandle::new(100));
    let e2 = store.insert_element(NativeHandle::new(200));

    assert_eq!(e1.to_string(), "@e1");
    assert_eq!(e2.to_string(), "@e2");
}

// ---------------------------------------------------------------------------
// Retrieve stored native handles by ref
// ---------------------------------------------------------------------------

#[test]
fn test_retrieve_window_handle() {
    let mut store = RefStore::new();
    let wref = store.insert_window(NativeHandle::new(0xABCD), 0);
    let retrieved = store.get_window(&wref);
    assert_eq!(retrieved, Some(NativeHandle::new(0xABCD)));
}

#[test]
fn test_retrieve_element_handle() {
    let mut store = RefStore::new();
    let eref = store.insert_element(NativeHandle::new(0xDEAD));
    let retrieved = store.get_element(&eref);
    assert_eq!(retrieved, Some(NativeHandle::new(0xDEAD)));
}
