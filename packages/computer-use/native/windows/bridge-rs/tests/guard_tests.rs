//! The production decision seam, with failures injected only at UIA boundaries.
use std::cell::Cell;
use windows_bridge::guard::{deliver_to_live_target, observe_after_delivery, Bounds, LiveTarget};
use windows_bridge::{ErrorCode, ProtocolError};

#[test]
fn uncertain_physical_failure_cannot_acknowledge_or_continue_a_batch() {
    let uncertain = ProtocolError::uncertain("partial OS input", ErrorCode::CaptureFailed);
    assert!(uncertain.outcome_uncertain());
    assert!(
        !ProtocolError::new("ordinary capture refusal", ErrorCode::CaptureFailed)
            .outcome_uncertain()
    );
    assert!(!unavailable().outcome_uncertain());
    assert_eq!(
        serde_json::to_value(&uncertain).unwrap(),
        serde_json::json!({"message":"partial OS input","code":"capture_failed"})
    );
}

#[test]
fn post_delivery_enumeration_failure_is_uncertain_without_retry() {
    let reads = Cell::new(0);
    let result: Result<(), ProtocolError> = observe_after_delivery(|| {
        reads.set(reads.get() + 1);
        Err(ProtocolError::new(
            "EnumWindows failed",
            ErrorCode::InternalError,
        ))
    });
    let error = result.unwrap_err();
    assert_eq!(reads.get(), 1);
    assert_eq!(error.code, ErrorCode::InternalError);
    assert!(error.outcome_uncertain());
}

#[test]
fn successful_post_delivery_observation_is_preserved() {
    let reads = Cell::new(0);
    let result = observe_after_delivery(|| {
        reads.set(reads.get() + 1);
        Ok(42)
    });
    assert_eq!(result.unwrap(), 42);
    assert_eq!(reads.get(), 1);
}

#[test]
fn partial_text_readback_cannot_be_acknowledged_as_refusal() {
    let error =
        windows_bridge::guard::verify_written_text("complete text", "complete").unwrap_err();
    assert!(error.outcome_uncertain());
    assert!(windows_bridge::guard::verify_written_text("complete text", "complete text").is_ok());
}

const WINDOW: Bounds = Bounds {
    x: -1000.0,
    y: 20.0,
    width: 800.0,
    height: 600.0,
};
const CONTROL: Bounds = Bounds {
    x: -900.0,
    y: 70.0,
    width: 100.0,
    height: 40.0,
};

fn unavailable() -> ProtocolError {
    ProtocolError::new("UIA target vanished", ErrorCode::StaleRef)
}

#[test]
fn unavailable_snapshot_delivers_no_input() {
    let deliveries = Cell::new(0);
    let result = deliver_to_live_target(
        &[42],
        WINDOW,
        || Err(unavailable()),
        |_, _| Ok(true),
        |_, _| {
            deliveries.set(deliveries.get() + 1);
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!(deliveries.get(), 0);
}

#[test]
fn failed_hit_test_delivers_no_input() {
    let deliveries = Cell::new(0);
    let result = deliver_to_live_target(
        &[42],
        WINDOW,
        || {
            Ok(LiveTarget {
                runtime_id: vec![42],
                bounds: CONTROL,
            })
        },
        |_, _| Err(unavailable()),
        |_, _| {
            deliveries.set(deliveries.get() + 1);
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!(deliveries.get(), 0);
}

#[test]
fn occluded_target_delivers_no_input() {
    let deliveries = Cell::new(0);
    let result = deliver_to_live_target(
        &[42],
        WINDOW,
        || {
            Ok(LiveTarget {
                runtime_id: vec![42],
                bounds: CONTROL,
            })
        },
        |_, _| Ok(false),
        |_, _| {
            deliveries.set(deliveries.get() + 1);
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!(deliveries.get(), 0);
}

#[test]
fn reused_automation_id_does_not_replace_runtime_identity() {
    let result: Result<(), _> = deliver_to_live_target(
        &[42],
        WINDOW,
        || {
            Ok(LiveTarget {
                runtime_id: vec![99],
                bounds: CONTROL,
            })
        },
        |_, _| Ok(true),
        |_, _| panic!("stale identity delivered input"),
    );
    assert!(result.is_err());
}

#[test]
fn invalid_or_outside_bounds_deliver_no_input() {
    for bounds in [
        Bounds {
            width: 0.0,
            ..CONTROL
        },
        Bounds {
            x: f64::NAN,
            ..CONTROL
        },
        Bounds {
            x: -1200.0,
            ..CONTROL
        },
        Bounds {
            width: f64::INFINITY,
            ..CONTROL
        },
    ] {
        let result: Result<(), _> = deliver_to_live_target(
            &[42],
            WINDOW,
            || {
                Ok(LiveTarget {
                    runtime_id: vec![42],
                    bounds,
                })
            },
            |_, _| Ok(true),
            |_, _| panic!("invalid geometry delivered input"),
        );
        assert!(result.is_err());
    }
}

#[test]
fn layout_shift_uses_current_negative_origin_bounds_once() {
    let point = deliver_to_live_target(
        &[42],
        WINDOW,
        || {
            Ok(LiveTarget {
                runtime_id: vec![42],
                bounds: CONTROL,
            })
        },
        |x, y| {
            assert_eq!((x, y), (-850.0, 90.0));
            Ok(true)
        },
        |x, y| Ok((x, y)),
    )
    .unwrap();
    assert_eq!(point, (-850.0, 90.0));
}

#[test]
fn uncertain_delivery_is_never_replayed() {
    let deliveries = Cell::new(0);
    let result: Result<(), _> = deliver_to_live_target(
        &[42],
        WINDOW,
        || {
            Ok(LiveTarget {
                runtime_id: vec![42],
                bounds: CONTROL,
            })
        },
        |_, _| Ok(true),
        |_, _| {
            deliveries.set(deliveries.get() + 1);
            Err(unavailable())
        },
    );
    assert!(result.is_err());
    assert_eq!(deliveries.get(), 1);
}
