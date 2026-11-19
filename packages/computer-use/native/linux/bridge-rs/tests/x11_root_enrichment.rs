//! Exercise production X11 root matching using snapshots, without a display server.

use linux_bridge::atspi::{AccessibleRef, Rect, RootSnapshot};
use linux_bridge::x11::{enrich_roots, WindowInfo};

fn frame(x: i32) -> Rect {
    Rect {
        x,
        y: 0,
        width: 100,
        height: 80,
    }
}

fn root(pid: u64, name: &str, frame: Option<Rect>) -> RootSnapshot {
    RootSnapshot {
        accessible: AccessibleRef {
            destination: ":1.2".into(),
            path: "/fixture".into(),
        },
        pid,
        name: name.into(),
        app_name: "Fixture".into(),
        role: "frame".into(),
        frame,
        x11_window: None,
        is_focused: false,
        is_minimized: false,
        z_order: None,
    }
}

fn window(id: u32, pid: u64, title: &str, x: i32) -> WindowInfo {
    WindowInfo {
        id,
        pid,
        title: title.into(),
        frame: frame(x),
        focused: false,
        minimized: false,
        z_order: 0,
    }
}

#[test]
fn ranks_title_then_geometry_and_assigns_each_window_once() {
    let mut roots = [
        root(7, "Editor", Some(frame(0))),
        root(7, "Editor", Some(frame(10))),
        root(7, "", None),
        root(7, "Unmatched", Some(frame(90))),
    ];
    let windows = [
        window(1, 8, "Editor", 0),
        window(2, 7, "Notes", 0),
        window(3, 7, "Editor (secondary)", 30),
        WindowInfo {
            focused: true,
            minimized: true,
            z_order: 4,
            ..window(4, 7, "Editor (primary)", 10)
        },
    ];

    enrich_roots(&mut roots, &windows);

    assert_eq!(
        roots.each_ref().map(|root| root.x11_window),
        [Some(4), Some(3), Some(2), None]
    );
    assert_eq!(roots[0].frame, Some(frame(10)));
    assert_eq!(roots[0].name, "Editor");
    assert!(roots[0].is_focused);
    assert!(roots[0].is_minimized);
    assert_eq!(roots[0].z_order, Some(4));
    assert_eq!(roots[2].name, "Notes");
    assert_eq!(roots[2].frame, Some(frame(0)));
    assert_eq!(roots[3].name, "Unmatched");
    assert_eq!(roots[3].frame, Some(frame(90)));
    assert_eq!(roots[3].z_order, None);
}

#[test]
fn prefers_window_title_contained_in_root_name_over_closer_unrelated_title() {
    let mut roots = [root(7, "Editor - file.txt", Some(frame(0)))];
    let windows = [window(1, 7, "Notes", 0), window(2, 7, "Editor", 30)];

    enrich_roots(&mut roots, &windows);

    assert_eq!(roots[0].x11_window, Some(2));
}

#[test]
fn missing_root_frame_leaves_equally_ranked_titles_in_window_order() {
    let mut roots = [root(7, "", None)];
    let windows = [window(1, 7, "Editor", 30), window(2, 7, "Notes", 0)];

    enrich_roots(&mut roots, &windows);

    assert_eq!(roots[0].x11_window, Some(1));
    assert_eq!(roots[0].frame, Some(frame(30)));
}

#[test]
fn rejects_unknown_process_ids_even_when_both_are_zero() {
    let mut roots = [root(0, "Editor", Some(frame(10)))];

    enrich_roots(&mut roots, &[window(1, 0, "Editor", 0)]);

    assert_eq!(roots[0].x11_window, None);
    assert_eq!(roots[0].frame, Some(frame(10)));
}
