//! Disposable crash fixture for the real Windows kernel input lease.
//! Cargo builds this separate binary before desktop integration tests; the test
//! receives its path through Cargo's compile-time executable constant.

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
