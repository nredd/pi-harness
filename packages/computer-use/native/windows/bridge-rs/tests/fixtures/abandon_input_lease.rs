//! Disposable crash fixture for the real Windows kernel input lease.
//! Cargo builds this separate binary before desktop integration tests; the test
//! receives its path through Cargo's compile-time executable constant.

#[cfg(windows)]
fn main() {
    let _lease = windows_bridge::desktop::PhysicalLease::acquire()
        .expect("disposable child owns the kernel lease");
    // Exit without destructors so the kernel, not a fake, abandons ownership.
    std::process::exit(0);
}

// Cargo requires a binary entry point for non-Windows all-target builds. This is
// not a test: only the Windows-only desktop test runs the crash fixture.
#[cfg(not(windows))]
fn main() {}
