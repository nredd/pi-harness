//! Win32 desktop/session permission checks and kernel-owned physical-input lease.
//!
//! No desktop switching, elevation, accessibility setting changes or grants.
//! References: Microsoft `OpenInputDesktop`, `GetThreadDesktop`,
//! `ProcessIdToSessionId`, `GetTokenInformation` and `CreateMutexW` documentation.

use crate::guard::Bounds;
use crate::{ErrorCode, ProtocolError};

/// Validate a live HWND, its process, interactive desktop and permission boundary.
/// Returns current physical bounds. A failed query is always a refusal.
pub fn validated_bounds(hwnd: isize, expected_pid: Option<u64>) -> Result<Bounds, ProtocolError> {
    #[cfg(windows)]
    {
        native::validated_bounds(hwnd, expected_pid)
    }
    #[cfg(not(windows))]
    {
        let _ = (hwnd, expected_pid);
        Err(ProtocolError::new(
            "Desktop validation requires Windows",
            ErrorCode::UnsupportedPlatform,
        ))
    }
}

/// Decide whether independently queried Win32 access evidence permits mutation.
/// A zero/nonmatching session, wrong desktop/station or higher-integrity target refuses.
pub fn access_allowed(
    helper_session: u32,
    target_session: u32,
    same_desktop: bool,
    interactive_station: bool,
    helper_integrity: u32,
    target_integrity: u32,
) -> bool {
    helper_session != 0
        && helper_session == target_session
        && same_desktop
        && interactive_station
        && target_integrity <= helper_integrity
}

/// Kernel-owned lease shared by helper processes in the interactive session.
/// The kernel releases ownership after thread/process death. Abandonment is a
/// refusal, never a signal to replay the previous action.
pub struct PhysicalLease {
    #[cfg(windows)]
    handle: windows::Win32::Foundation::HANDLE,
}

impl PhysicalLease {
    /// Wait for a bounded interval without stealing a live or uncertain owner.
    pub fn acquire() -> Result<Self, ProtocolError> {
        #[cfg(windows)]
        {
            native::acquire()
        }
        #[cfg(not(windows))]
        {
            Ok(Self {})
        }
    }
}

#[cfg(windows)]
impl Drop for PhysicalLease {
    fn drop(&mut self) {
        // SAFETY: acquire owns this mutex on this thread; the handle is not shared.
        unsafe {
            let _ = windows::Win32::System::Threading::ReleaseMutex(self.handle);
            let _ = windows::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(windows)]
mod native {
    use super::{Bounds, ErrorCode, PhysicalLease, ProtocolError};
    use windows::core::w;
    use windows::Win32::Foundation::{
        CloseHandle, HANDLE, HWND, RECT, WAIT_ABANDONED, WAIT_OBJECT_0,
    };
    use windows::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, IsValidSid,
        TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
    use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows::Win32::System::StationsAndDesktops::*;
    use windows::Win32::System::Threading::*;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, GetWindowThreadProcessId, IsWindow,
    };

    fn refused() -> ProtocolError {
        ProtocolError::new(
            "Target desktop/session or permissions could not be verified",
            ErrorCode::CoordinateBlocked,
        )
    }

    // Borrowed desktop/window-station handles are never closed here.
    unsafe fn object_name(handle: HANDLE) -> Result<Vec<u16>, ProtocolError> {
        let mut name = [0u16; 256];
        let mut needed = 0;
        GetUserObjectInformationW(
            handle,
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            512,
            Some(&mut needed),
        )
        .map_err(|_| refused())?;
        let len = name
            .iter()
            .position(|unit| *unit == 0)
            .ok_or_else(refused)?;
        Ok(name[..len].to_vec())
    }

    /// Read a token's mandatory integrity RID without changing its privileges.
    unsafe fn integrity(process: HANDLE) -> Result<u32, ProtocolError> {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).map_err(|_| refused())?;
        // Pointer-sized storage keeps TOKEN_MANDATORY_LABEL correctly aligned.
        let mut storage = [0usize; 64];
        let mut needed = 0;
        let queried = GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(storage.as_mut_ptr().cast()),
            std::mem::size_of_val(&storage) as u32,
            &mut needed,
        );
        let _ = CloseHandle(token);
        queried.map_err(|_| refused())?;
        let label = &*storage.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
        if !IsValidSid(label.Label.Sid).as_bool() {
            return Err(refused());
        }
        let count = *GetSidSubAuthorityCount(label.Label.Sid);
        if count == 0 {
            return Err(refused());
        }
        Ok(*GetSidSubAuthority(label.Label.Sid, u32::from(count - 1)))
    }

    pub fn validated_bounds(
        hwnd: isize,
        expected_pid: Option<u64>,
    ) -> Result<Bounds, ProtocolError> {
        // SAFETY: every borrowed HWND is checked; all created handles close before return.
        unsafe {
            let hwnd = HWND(hwnd as *mut _);
            if !IsWindow(hwnd).as_bool() {
                return Err(refused());
            }
            let mut pid = 0;
            let tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if tid == 0
                || pid == 0
                || expected_pid.is_some_and(|expected| expected != u64::from(pid))
            {
                return Err(refused());
            }
            let mut ours = 0;
            let mut theirs = 0;
            ProcessIdToSessionId(GetCurrentProcessId(), &mut ours).map_err(|_| refused())?;
            ProcessIdToSessionId(pid, &mut theirs).map_err(|_| refused())?;
            let station = GetProcessWindowStation().map_err(|_| refused())?;
            let interactive_station =
                object_name(HANDLE(station.0))? == "WinSta0".encode_utf16().collect::<Vec<_>>();
            let current = GetThreadDesktop(GetCurrentThreadId()).map_err(|_| refused())?;
            let target = GetThreadDesktop(tid).map_err(|_| refused())?;
            let input = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
                .map_err(|_| refused())?;
            let names = (
                object_name(HANDLE(input.0)),
                object_name(HANDLE(current.0)),
                object_name(HANDLE(target.0)),
            );
            let _ = CloseDesktop(input);
            let (input_name, current_name, target_name) = names;
            let input_name = input_name?;
            let same_desktop = input_name == current_name? && input_name == target_name?;
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                .map_err(|_| refused())?;
            let target_integrity = integrity(process);
            let _ = CloseHandle(process);
            if !super::access_allowed(
                ours,
                theirs,
                same_desktop,
                interactive_station,
                integrity(GetCurrentProcess())?,
                target_integrity?,
            ) {
                return Err(refused());
            }
            let mut rect = RECT::default();
            GetWindowRect(hwnd, &mut rect).map_err(|_| refused())?;
            Ok(Bounds {
                x: f64::from(rect.left),
                y: f64::from(rect.top),
                width: f64::from(rect.right - rect.left),
                height: f64::from(rect.bottom - rect.top),
            })
        }
    }

    pub fn acquire() -> Result<PhysicalLease, ProtocolError> {
        // SAFETY: the local-session mutex is owned only on WAIT_OBJECT_0; every
        // other path closes its handle, including releasing abandoned ownership.
        unsafe {
            let handle = CreateMutexW(None, false, w!("Local\\PiComputerUsePhysicalInput-v1"))
                .map_err(|_| refused())?;
            let waited = WaitForSingleObject(handle, 5000);
            if waited == WAIT_OBJECT_0 {
                return Ok(PhysicalLease { handle });
            }
            if waited == WAIT_ABANDONED {
                let _ = ReleaseMutex(handle);
            }
            let _ = CloseHandle(handle);
            Err(ProtocolError::new(
                "Physical input lease unavailable or abandoned; no action was sent",
                ErrorCode::CoordinateBlocked,
            ))
        }
    }
}
