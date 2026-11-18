//! Disposable crash fixture for the real Windows kernel input lease.
//! Cargo test builds examples before running the desktop integration tests.

fn main() {
    #[cfg(windows)]
    {
        let _lease = windows_bridge::desktop::PhysicalLease::acquire()
            .expect("disposable child owns the kernel lease");
        // Exit without destructors so the kernel, not a fake, abandons ownership.
        std::process::exit(0);
    }
    #[cfg(not(windows))]
    {
        eprintln!("Kernel lease abandonment requires Windows");
        std::process::exit(3);
    }
}
