//! Mandatory access decisions use independent Win32 evidence before mutation.
use windows_bridge::desktop::access_allowed;

#[test]
fn refuses_wrong_or_service_session() {
    assert!(!access_allowed(1, 2, true, true, 8192, 8192));
    assert!(!access_allowed(0, 0, true, true, 8192, 8192));
}

#[test]
fn refuses_secure_or_noninteractive_desktop() {
    assert!(!access_allowed(1, 1, false, true, 8192, 8192));
    assert!(!access_allowed(1, 1, true, false, 8192, 8192));
}

#[test]
fn refuses_higher_integrity_without_granting_privileges() {
    assert!(!access_allowed(1, 1, true, true, 8192, 12288));
    assert!(access_allowed(1, 1, true, true, 8192, 8192));
    assert!(access_allowed(1, 1, true, true, 8192, 4096));
}

/// Actual Win32 ownership and process-death tests need no interactive desktop.
#[cfg(windows)]
#[test]
fn windows_kernel_input_lease() {
    use std::sync::mpsc;
    use windows::core::w;
    use windows_bridge::desktop::PhysicalLease;
    if std::env::var_os("PI_NATIVE_MUTEX_ABANDON").is_some() {
        let _lease = PhysicalLease::acquire().expect("child owns kernel lease");
        // Exit without Rust destructors: the kernel, not a fake, abandons ownership.
        std::process::exit(0);
    }
    let lease = PhysicalLease::acquire().expect("first session");
    let (started, waiting) = mpsc::channel();
    let contender = std::thread::spawn(move || {
        started.send(()).expect("contender started");
        let _lease = PhysicalLease::acquire().expect("second session queues");
    });
    waiting.recv().expect("contender running");
    assert!(
        !contender.is_finished(),
        "second session cannot interleave while first owns lease"
    );
    drop(lease);
    // The lease is thread-owned, so acquire/drop it on the contender thread.
    // Do not move an acquired HANDLE to the test thread.
    contender.join().expect("queued lease acquired");

    // A waiting helper's open handle preserves observable abandonment.
    let anchor = unsafe {
        windows::Win32::System::Threading::CreateMutexW(
            None,
            false,
            w!("Local\\PiComputerUsePhysicalInput-v1"),
        )
    }
    .expect("open waiting-session anchor");
    let status = std::process::Command::new(std::env::current_exe().expect("test executable"))
        .args(["--exact", "windows_kernel_input_lease", "--nocapture"])
        .env("PI_NATIVE_MUTEX_ABANDON", "1")
        .status()
        .expect("spawn disposable crash fixture");
    assert!(status.success());
    assert!(
        PhysicalLease::acquire().is_err(),
        "abandonment refuses rather than replaying unknown input"
    );
    drop(PhysicalLease::acquire().expect("explicit subsequent request can acquire clean lease"));
    unsafe { windows::Win32::Foundation::CloseHandle(anchor) }.expect("close fixture anchor");
}
