//! Private, atomic journal for XTEST releases. A single slot per home serializes
//! even different DISPLAY aliases of the same server.

use std::collections::hash_map::RandomState;
use std::fs::File;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Read, Write};
use std::os::fd::OwnedFd;
use std::path::{Component, Path, PathBuf};

use rustix::fs::{
    fchmod, flock, fstat, fsync, mkdirat, openat, renameat, unlinkat, AtFlags, FileType,
    FlockOperation, Mode, OFlags, CWD,
};
use rustix::io::Errno;
use rustix::process::geteuid;
use serde::{Deserialize, Serialize};

use super::Owed;

const DIR: &str = ".pi-computer-use-input";
const RECORD: &str = "release-debt.json";
const LOCK: &str = "lock";
const MAX_RECORD_BYTES: usize = 64 * 1024;
const MAX_BOOT_ID_BYTES: usize = 128;

/// Live X server instance, login session (if exported), and local boot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Binding {
    pub(super) server_id: String,
    pub(super) session_id: Option<String>,
    pub(super) boot_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    server: Binding,
    releases: Vec<Owed>,
}

/// Read the kernel boot UUID from `<proc_root>/sys/kernel/random/boot_id` safely
/// (`O_NOFOLLOW | O_NONBLOCK`, regular file, bounded).
pub fn read_boot_id_from(proc_root: &Path) -> Result<String, String> {
    let path = proc_root.join("sys/kernel/random/boot_id");
    let fd = openat(
        CWD,
        &path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|err| format!("cannot open '{}': {err}", path.display()))?;
    let stat = fstat(&fd).map_err(|err| format!("cannot stat '{}': {err}", path.display()))?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(format!("'{}' is not a regular file", path.display()));
    }
    let mut bytes = Vec::new();
    File::from(fd)
        .take(MAX_BOOT_ID_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("cannot read '{}': {err}", path.display()))?;
    if bytes.len() > MAX_BOOT_ID_BYTES {
        return Err(format!(
            "'{}' exceeds {MAX_BOOT_ID_BYTES} bytes",
            path.display()
        ));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| format!("'{}' is not valid UTF-8", path.display()))?
        .trim();
    if text.is_empty() || text.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return Err(format!("'{}' does not contain a boot id", path.display()));
    }
    Ok(text.to_owned())
}

/// Generate a random 128-bit lowercase hex identifier from OS-seeded `RandomState`.
pub fn random_hex_128() -> String {
    let first = RandomState::new().build_hasher().finish();
    let second = RandomState::new().build_hasher().finish();
    format!("{first:016x}{second:016x}")
}

/// Private slot, exclusively locked until close. Never unlink the lock file.
#[derive(Debug)]
pub(super) struct Journal {
    dir: OwnedFd,
    _lock: OwnedFd,
    path: PathBuf,
    record: Option<Record>,
}

impl Journal {
    pub(super) fn open(home: &Path) -> Result<Self, String> {
        let uid = geteuid().as_raw();
        let anchor = open_anchor_dir(home, uid, false)?;
        let dir_path = home.join(DIR);
        let dir = descend_dir(&anchor, DIR, &dir_path, uid, true)?;
        // Also sync when the directory already exists: an earlier opener may have
        // created it and exited before its parent entry was durable.
        sync_dir(&anchor)
            .map_err(|err| format!("cannot sync journal parent '{}': {err}", home.display()))?;
        let lock_path = dir_path.join(LOCK);
        let lock = acquire_lock(&dir, &lock_path)?;
        let path = dir_path.join(RECORD);
        let record = read_existing_record(&dir, RECORD, &path)?;
        Ok(Self {
            dir,
            _lock: lock,
            path,
            record,
        })
    }

    /// Refuse restart debt before even connecting to X11. The old connection's
    /// requests may still be pending, so an up observation cannot settle it.
    pub(super) fn require_fresh(&self) -> Result<(), String> {
        if !self.releases().is_empty() {
            return Err(self.recovery(
                "A previous helper may still have queued X11 input. Manual recovery required.",
            ));
        }
        Ok(())
    }

    /// Refuse a record from another desktop before any XTEST or state query.
    pub(super) fn bind(&self, live: &Binding) -> Result<(), String> {
        if self
            .record
            .as_ref()
            .is_some_and(|record| &record.server != live)
        {
            return Err(
                self.recovery("The record belongs to a different X server, session or boot.")
            );
        }
        Ok(())
    }

    /// Reconnect settlement requires positive evidence of the original session.
    pub(super) fn bind_for_reconnect(&self, live: &Binding) -> Result<(), String> {
        self.bind(live)?;
        if !self.releases().is_empty() && live.session_id.is_none() {
            return Err(self.recovery(
                "Cannot verify the original login session: XDG_SESSION_ID is unavailable.",
            ));
        }
        Ok(())
    }

    pub(super) fn releases(&self) -> &[Owed] {
        self.record.as_ref().map_or(&[], |record| &record.releases)
    }

    pub(super) fn recovery(&self, cause: &str) -> String {
        let names = self
            .releases()
            .iter()
            .map(|entry| entry.describe())
            .collect::<Vec<_>>()
            .join(", ");
        format!("Refusing physical input: the release of {names} is unconfirmed. {cause} Release the inputs by hand on the original desktop. If physical input remains refused, stop all helpers using this journal, verify that no input remains held, and remove only '{}'. Do not remove the lock file.", self.path.display())
    }

    /// Atomically replace the debt, or clear it once all releases are confirmed.
    pub(super) fn sync(&mut self, server: &Binding, releases: Vec<Owed>) -> Result<(), String> {
        self.bind(server)?;
        let next = (!releases.is_empty()).then(|| Record {
            version: 1,
            server: server.clone(),
            releases,
        });
        self.publish(next).map_err(|cause| format!("could not update release-debt record '{}': {cause}; verify that the inputs are up before clearing the record", self.path.display()))
    }

    fn publish(&mut self, next: Option<Record>) -> io::Result<()> {
        self.publish_with(next, sync_dir)
    }

    fn publish_with(
        &mut self,
        next: Option<Record>,
        sync: impl FnOnce(&OwnedFd) -> io::Result<()>,
    ) -> io::Result<()> {
        let Some(record) = next.as_ref() else {
            match unlinkat(&self.dir, RECORD, AtFlags::empty()) {
                Ok(()) | Err(Errno::NOENT) => {}
                Err(err) => return Err(err.into()),
            }
            sync(&self.dir)?;
            self.record = None;
            return Ok(());
        };
        let bytes = serde_json::to_vec(record).map_err(io::Error::other)?;
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(io::Error::other(
                "release-debt record exceeded its size limit",
            ));
        }
        let stage = format!(".stage-{}-{}", std::process::id(), random_hex_128());
        let fd = openat(
            &self.dir,
            &stage,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )?;
        let result = (|| {
            fchmod(&fd, Mode::RUSR | Mode::WUSR)?;
            let mut file = File::from(fd);
            file.write_all(&bytes)?;
            file.sync_all()?;
            renameat(&self.dir, &stage, &self.dir, RECORD).map_err(io::Error::from)
        })();
        if let Err(err) = result {
            let _ = unlinkat(&self.dir, &stage, AtFlags::empty());
            return Err(err);
        }
        // Rename already published the record. Keep it for recovery even if
        // the directory sync fails; callers must still refuse the press.
        self.record = next;
        sync(&self.dir)
    }
}

fn unreadable_record_message(path: &Path, cause: &str) -> String {
    format!(
        "Refusing physical input: the release-debt record '{}' cannot be read safely ({cause}), so held inputs are unknown. Check that no key or button is stuck. Stop all helpers using this journal, then remove '{}' to clear the record. Do not remove the lock file.",
        path.display(),
        path.display()
    )
}

fn is_clean_absolute(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
}

fn open_anchor_dir(path: &Path, uid: u32, strict_private: bool) -> Result<OwnedFd, String> {
    if !is_clean_absolute(path) {
        return Err(format!("'{}' is not a clean absolute path", path.display()));
    }
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let open_error = |err| format!("cannot open '{}': {err}", path.display());
    let mut fd = openat(CWD, "/", flags, Mode::empty()).map_err(open_error)?;
    for part in path.components() {
        if let Component::Normal(name) = part {
            let stat = fstat(&fd).map_err(open_error)?;
            // Linux is the shipped runtime. Headless macOS tests can run under
            // a shared scratch mount, while still validating the journal itself.
            if cfg!(target_os = "linux")
                && !trusted_ancestor(stat.st_uid, uid, Mode::from_raw_mode(stat.st_mode))
            {
                return Err(format!("unsafe ancestor of '{}'", path.display()));
            }
            fd = openat(&fd, name, flags, Mode::empty()).map_err(open_error)?;
        }
    }
    validate_dir_fd(&fd, path, uid, strict_private)?;
    Ok(fd)
}

fn trusted_ancestor(owner: u32, uid: u32, mode: Mode) -> bool {
    (owner == 0 || owner == uid)
        && (!mode.intersects(Mode::WGRP | Mode::WOTH) || mode.contains(Mode::SVTX))
}

fn descend_dir(
    parent_fd: &OwnedFd,
    name: &str,
    full_path: &Path,
    uid: u32,
    strict_leaf: bool,
) -> Result<OwnedFd, String> {
    let created = match mkdirat(parent_fd, name, Mode::RWXU) {
        Ok(()) => true,
        Err(err) if err == Errno::EXIST => false,
        Err(err) => return Err(format!("cannot create '{}': {err}", full_path.display())),
    };
    let fd = openat(
        parent_fd,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|err| format!("cannot open '{}': {err}", full_path.display()))?;
    if created {
        fchmod(&fd, Mode::RWXU)
            .map_err(|err| format!("cannot chmod '{}': {err}", full_path.display()))?;
    }
    validate_dir_fd(&fd, full_path, uid, strict_leaf)?;
    Ok(fd)
}

fn validate_dir_fd(
    fd: &OwnedFd,
    path: &Path,
    uid: u32,
    strict_private: bool,
) -> Result<(), String> {
    let stat = fstat(fd).map_err(|err| format!("cannot stat '{}': {err}", path.display()))?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::Directory {
        return Err(format!("'{}' is not a directory", path.display()));
    }
    if stat.st_uid != uid {
        return Err(format!(
            "'{}' is owned by uid {}, expected {uid}",
            path.display(),
            stat.st_uid
        ));
    }
    let mode = Mode::from_raw_mode(stat.st_mode);
    if strict_private {
        if mode != Mode::RWXU {
            return Err(format!(
                "'{}' has mode {:04o}, expected 0700",
                path.display(),
                mode.bits()
            ));
        }
    } else if mode.intersects(Mode::WGRP | Mode::WOTH) {
        return Err(format!(
            "'{}' is group- or world-writable ({:04o})",
            path.display(),
            mode.bits()
        ));
    }
    Ok(())
}

fn acquire_lock(dir_fd: &OwnedFd, lock_path: &Path) -> Result<OwnedFd, String> {
    let uid = geteuid().as_raw();
    let (fd, created) = match openat(
        dir_fd,
        LOCK,
        OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    ) {
        Ok(fd) => (fd, true),
        Err(err) if err == Errno::EXIST => {
            let fd = openat(
                dir_fd,
                LOCK,
                OFlags::RDWR | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|open_err| {
                format!("cannot open lock '{}': {open_err}", lock_path.display())
            })?;
            (fd, false)
        }
        Err(err) => {
            return Err(format!(
                "cannot create lock '{}': {err}",
                lock_path.display()
            ))
        }
    };
    if created {
        fchmod(&fd, Mode::RUSR | Mode::WUSR)
            .map_err(|err| format!("cannot chmod lock '{}': {err}", lock_path.display()))?;
    }
    let stat =
        fstat(&fd).map_err(|err| format!("cannot stat lock '{}': {err}", lock_path.display()))?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(format!(
            "lock '{}' is not a regular file",
            lock_path.display()
        ));
    }
    if stat.st_uid != uid {
        return Err(format!(
            "lock '{}' is owned by uid {}, expected {uid}",
            lock_path.display(),
            stat.st_uid
        ));
    }
    let mode = Mode::from_raw_mode(stat.st_mode);
    if mode != (Mode::RUSR | Mode::WUSR) {
        return Err(format!(
            "lock '{}' has mode {:04o}, expected 0600",
            lock_path.display(),
            mode.bits()
        ));
    }

    flock(&fd, FlockOperation::NonBlockingLockExclusive).map_err(|err| {
        format!(
            "cannot acquire release-debt lock '{}': {err}",
            lock_path.display()
        )
    })?;
    Ok(fd)
}

fn read_existing_record(
    dir_fd: &OwnedFd,
    record_name: &str,
    record_path: &Path,
) -> Result<Option<Record>, String> {
    let fd = match openat(
        dir_fd,
        record_name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(err) if err == Errno::NOENT => return Ok(None),
        Err(err) => return Err(unreadable_record_message(record_path, &err.to_string())),
    };
    let stat =
        fstat(&fd).map_err(|err| unreadable_record_message(record_path, &err.to_string()))?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(unreadable_record_message(record_path, "not a regular file"));
    }
    let uid = geteuid().as_raw();
    if stat.st_uid != uid {
        return Err(unreadable_record_message(
            record_path,
            &format!("owned by uid {}, expected {uid}", stat.st_uid),
        ));
    }
    let mode = Mode::from_raw_mode(stat.st_mode);
    if mode != (Mode::RUSR | Mode::WUSR) {
        return Err(unreadable_record_message(
            record_path,
            &format!("mode {:04o}, expected 0600", mode.bits()),
        ));
    }
    if u64::try_from(stat.st_size).map_or(true, |size| size > MAX_RECORD_BYTES as u64) {
        return Err(unreadable_record_message(
            record_path,
            &format!("exceeds {MAX_RECORD_BYTES} bytes"),
        ));
    }
    let mut bytes = Vec::new();
    File::from(fd)
        .take(MAX_RECORD_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| unreadable_record_message(record_path, &err.to_string()))?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(unreadable_record_message(
            record_path,
            &format!("exceeds {MAX_RECORD_BYTES} bytes"),
        ));
    }

    let record: Record = serde_json::from_slice(&bytes)
        .map_err(|err| unreadable_record_message(record_path, &err.to_string()))?;
    if record.version != 1
        || record.releases.is_empty()
        || record.releases.iter().enumerate().any(|(i, entry)| {
            !entry.valid()
                || record.releases[..i]
                    .iter()
                    .any(|prev| prev.same_input(*entry))
        })
    {
        return Err(unreadable_record_message(
            record_path,
            "invalid release-debt record",
        ));
    }
    Ok(Some(record))
}

fn sync_dir(dir: &OwnedFd) -> io::Result<()> {
    fsync(dir).map_err(io::Error::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn foreign_binding_never_overwrites_or_clears_record() {
        let home = tempfile::tempdir().unwrap();
        let owner = Binding {
            server_id: "a".into(),
            session_id: Some("s".into()),
            boot_id: "b".into(),
        };
        let mut journal = Journal::open(home.path()).unwrap();
        let owed = Owed {
            event: super::super::KEY_RELEASE_EVENT,
            detail: 37,
            ambiguous: false,
        };
        journal.sync(&owner, vec![owed]).unwrap();
        let record = journal.path.clone();
        drop(journal);
        let mut reader = Journal::open(home.path()).unwrap();
        let original = fs::read(&record).unwrap();
        for different in [
            Binding {
                server_id: "other".into(),
                ..owner.clone()
            },
            Binding {
                session_id: None,
                ..owner.clone()
            },
            Binding {
                boot_id: "other".into(),
                ..owner.clone()
            },
        ] {
            let error = reader.sync(&different, Vec::new()).unwrap_err();
            assert!(
                error.contains("keycode 37") && error.contains("remove"),
                "{error}"
            );
            assert_eq!(fs::read(&record).unwrap(), original);
        }
        reader.sync(&owner, Vec::new()).unwrap();
        assert!(!record.exists());
    }

    #[test]
    fn published_record_remains_named_after_directory_sync_failure() {
        let home = tempfile::tempdir().unwrap();
        let mut journal = Journal::open(home.path()).unwrap();
        let record = Record {
            version: 1,
            server: Binding {
                server_id: "x".into(),
                boot_id: "b".into(),
                session_id: None,
            },
            releases: vec![Owed {
                event: super::super::KEY_RELEASE_EVENT,
                detail: 37,
                ambiguous: false,
            }],
        };
        assert!(journal
            .publish_with(Some(record), |_| Err(io::Error::other("sync failed")))
            .is_err());
        assert!(journal.recovery("sync failed").contains("keycode 37"));
        assert!(journal.path.is_file());
    }

    #[test]
    fn reconnect_cannot_settle_without_a_session_id() {
        let home = tempfile::tempdir().unwrap();
        let mut journal = Journal::open(home.path()).unwrap();
        let live = Binding {
            server_id: "x".into(),
            boot_id: "b".into(),
            session_id: None,
        };
        journal
            .sync(
                &live,
                vec![Owed {
                    event: super::super::KEY_RELEASE_EVENT,
                    detail: 37,
                    ambiguous: false,
                }],
            )
            .unwrap();
        assert!(journal
            .bind_for_reconnect(&live)
            .unwrap_err()
            .contains("keycode 37"));
        assert_eq!(journal.releases().len(), 1);
    }

    #[test]
    fn rejects_untrusted_ancestor_modes() {
        assert!(!trusted_ancestor(1000, 1000, Mode::from_raw_mode(0o777)));
        assert!(!trusted_ancestor(1000, 1000, Mode::from_raw_mode(0o775)));
        assert!(!trusted_ancestor(1001, 1000, Mode::from_raw_mode(0o755)));
        assert!(trusted_ancestor(0, 1000, Mode::from_raw_mode(0o1777)));
        assert!(trusted_ancestor(1000, 1000, Mode::from_raw_mode(0o700)));
    }

    #[test]
    fn unsafe_directory_and_record_paths_fail_closed() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(DIR);
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Journal::open(home.path()).unwrap_err().contains("0700"));
        fs::remove_dir(&dir).unwrap();
        symlink(home.path(), &dir).unwrap();
        assert!(Journal::open(home.path()).is_err());
        fs::remove_file(&dir).unwrap();
        drop(Journal::open(home.path()).unwrap());
        let path = dir.join(RECORD);
        symlink(&dir, &path).unwrap();
        assert!(Journal::open(home.path())
            .unwrap_err()
            .contains("cannot be read safely"));
        fs::remove_file(&path).unwrap();
        assert!(std::process::Command::new("/usr/bin/mkfifo")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        assert!(Journal::open(home.path())
            .unwrap_err()
            .contains("not a regular file"));
        fs::remove_file(&path).unwrap();
        fs::write(&path, vec![b' '; MAX_RECORD_BYTES + 1]).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(Journal::open(home.path()).unwrap_err().contains("exceeds"));
    }
}
