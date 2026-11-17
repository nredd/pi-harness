//! Inject only the OS delivery/release boundary, never a synthetic helper.
use std::cell::Cell;
use windows_bridge::input::with_input_cleanup;
use windows_bridge::{ErrorCode, ProtocolError};

fn failed() -> ProtocolError {
    ProtocolError::uncertain("partial OS input", ErrorCode::CaptureFailed)
}

#[test]
fn partial_input_failure_releases_once_without_replay() {
    let actions = Cell::new(0);
    let releases = Cell::new(0);
    let result: Result<(), _> = with_input_cleanup(
        || {
            actions.set(actions.get() + 1);
            Err(failed())
        },
        || {
            releases.set(releases.get() + 1);
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!(actions.get(), 1);
    assert_eq!(releases.get(), 1);
}

#[test]
fn failed_release_does_not_claim_success_or_retry() {
    let releases = Cell::new(0);
    let result = with_input_cleanup(
        || Ok(()),
        || {
            releases.set(releases.get() + 1);
            Err(failed())
        },
    );
    assert!(result.is_err());
    assert_eq!(releases.get(), 1);
}

#[test]
fn uncertain_release_cannot_be_hidden_by_an_ordinary_refusal() {
    let result: Result<(), _> = with_input_cleanup(
        || {
            Err(ProtocolError::new(
                "ordinary refusal",
                ErrorCode::InvalidRequest,
            ))
        },
        || Err(failed()),
    );
    assert!(result.unwrap_err().outcome_uncertain());
}

#[test]
fn success_requires_completed_release() {
    let released = Cell::new(false);
    let value = with_input_cleanup(
        || Ok(42),
        || {
            released.set(true);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(value, 42);
    assert!(released.get());
}
