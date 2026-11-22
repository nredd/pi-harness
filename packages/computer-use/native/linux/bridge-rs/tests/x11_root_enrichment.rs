//! Exercise production X11 root matching using snapshots, without a display server.

use linux_bridge::atspi::{AccessibleRef, Rect, RootSnapshot};
use linux_bridge::x11::{enrich_roots, parse_wm_class, wm_class_property, WindowInfo};

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
        executable: None,
        wm_class: None,
        class_candidates: Vec::new(),
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
        wm_class: None,
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
fn copies_the_paired_window_class_without_touching_identity() {
    let mut roots = [root(7, "Editor", Some(frame(0))), root(8, "Other", None)];
    let class = Some(("fixture".to_owned(), "Fixture".to_owned()));
    let windows = [WindowInfo {
        wm_class: class.clone(),
        ..window(1, 7, "Editor", 0)
    }];

    enrich_roots(&mut roots, &windows);

    assert_eq!(roots[0].wm_class, class);
    assert_eq!(roots[0].executable, None);
    assert_eq!(roots[1].wm_class, None);
}

#[test]
fn an_equally_ranked_sibling_window_leaves_the_class_unattributed() {
    let class = |name: &str| Some((name.to_owned(), name.to_owned()));
    // Two windows of one process with the same title and bounds, one with a blocked class.
    let mut roots = [
        root(7, "Editor", Some(frame(0))),
        root(7, "Editor", Some(frame(0))),
    ];
    let windows = [
        WindowInfo {
            wm_class: class("keepassxc"),
            ..window(1, 7, "Editor", 0)
        },
        WindowInfo {
            wm_class: class("fixture"),
            ..window(2, 7, "Editor", 0)
        },
    ];

    enrich_roots(&mut roots, &windows);

    // Each root still pairs with one window, but neither class is evidence for it, including
    // the second root, whose only remaining window is a consequence of the first choice.
    assert_eq!(
        roots.each_ref().map(|root| root.x11_window),
        [Some(1), Some(2)]
    );
    assert_eq!(
        roots.each_ref().map(|root| root.wm_class.clone()),
        [None, None]
    );
    // Blocking is additive: every tied class stays a block-only candidate of both roots.
    let tied = vec![class("keepassxc").unwrap(), class("fixture").unwrap()];
    assert_eq!(
        roots.each_ref().map(|root| root.class_candidates.clone()),
        [tied.clone(), tied]
    );

    // A distinct best rank still carries its class, even beside a lower-ranked sibling.
    let mut roots = [root(7, "Editor", Some(frame(0)))];
    let windows = [
        WindowInfo {
            wm_class: class("fixture"),
            ..window(1, 7, "Editor", 0)
        },
        WindowInfo {
            wm_class: class("keepassxc"),
            ..window(2, 7, "Editor", 30)
        },
    ];
    enrich_roots(&mut roots, &windows);
    assert_eq!(roots[0].x11_window, Some(1));
    assert_eq!(roots[0].wm_class, class("fixture"));
    assert!(roots[0].class_candidates.is_empty());
}

#[test]
fn parses_only_well_formed_wm_class_values() {
    assert_eq!(
        parse_wm_class(b"keepassxc\0KeePassXC\0"),
        Some(("keepassxc".into(), "KeePassXC".into()))
    );
    assert_eq!(
        parse_wm_class(b"\0Caf\xe9\0"),
        Some((String::new(), "Caf\u{e9}".into()))
    );
    for malformed in [
        &b""[..],
        b"keepassxc",
        b"keepassxc\0",
        b"keepassxc\0\0",
        b"a\0b\0c\0",
        b"a\0b",
    ] {
        assert_eq!(parse_wm_class(malformed), None, "{malformed:?}");
    }
}

#[test]
fn reads_only_complete_8_bit_wm_class_properties() {
    let value = b"keepassxc\0KeePassXC\0";
    assert_eq!(
        wm_class_property(8, 0, value),
        Some(("keepassxc".into(), "KeePassXC".into()))
    );
    for (format, bytes_after) in [(16, 0), (32, 0), (0, 0), (8, 1)] {
        assert_eq!(
            wm_class_property(format, bytes_after, value),
            None,
            "format {format}, bytes_after {bytes_after}"
        );
    }
    assert_eq!(wm_class_property(8, 0, b"keepassxc"), None);
}

#[test]
fn rejects_unknown_process_ids_even_when_both_are_zero() {
    let mut roots = [root(0, "Editor", Some(frame(10)))];

    enrich_roots(&mut roots, &[window(1, 0, "Editor", 0)]);

    assert_eq!(roots[0].x11_window, None);
    assert_eq!(roots[0].frame, Some(frame(10)));
}
