//! Owed XTEST releases recorded across helper restarts.
//!
//! A helper that exits with an unconfirmed release writes it to a private file; the
//! next helper loads it before its first request and refuses physical input with
//! `input_unsafe` until a fresh connection confirms the release. The file lives at
//! `$XDG_RUNTIME_DIR/pi-computer-use/linux-input-debt.json`, else under
//! `$XDG_CACHE_HOME` or `~/.cache`, with mode `0600` in a `0700` directory.
use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::x11::{InputState, RecordedRelease};

const FILE_NAME: &str = "linux-input-debt.json";
const VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    /// `DISPLAY` the releases are owed on.
    display: Option<String>,
    /// Seconds since the Unix epoch.
    saved_at: u64,
    releases: Vec<RecordedRelease>,
}

/// The restart record's location.
#[derive(Debug, Clone)]
pub struct DebtFile {
    path: PathBuf,
}
impl DebtFile {
    /// Resolve the location from the environment, or `None` when no absolute runtime,
    /// cache or home directory is set.
    pub fn locate() -> Option<Self> {
        Self::locate_with(|name| std::env::var_os(name))
    }
    fn locate_with(env: impl Fn(&str) -> Option<OsString>) -> Option<Self> {
        let var = |name| {
            env(name)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
        };
        let dir = var("XDG_RUNTIME_DIR")
            .or_else(|| var("XDG_CACHE_HOME"))
            .or_else(|| var("HOME").map(|home| home.join(".cache")))?;
        Some(Self::at(dir.join("pi-computer-use").join(FILE_NAME)))
    }
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    /// Load an earlier helper's owed releases into `state`. Releases owed on another
    /// display turn ambiguous: a release posted here could end someone else's hold.
    /// A record that cannot be read blocks physical input, since nothing can settle
    /// what it named. A missing file is no debt.
    pub fn load_into(&self, state: &InputState, display: Option<&str>) {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return,
            Err(error) => return self.block(state, &error.to_string()),
        };
        let record = match serde_json::from_str::<Record>(&text) {
            Ok(record) if record.version == VERSION => record,
            Ok(record) => {
                return self.block(state, &format!("unsupported version {}", record.version))
            }
            Err(error) => return self.block(state, &error.to_string()),
        };
        let same_display = record.display.as_deref() == display;
        let releases = record
            .releases
            .into_iter()
            .map(|release| RecordedRelease {
                ambiguous: release.ambiguous || !same_display,
                ..release
            })
            .collect::<Vec<_>>();
        state.restore(&releases);
    }
    /// Record `state`'s owed releases, or remove the record once none remain. Leaves an
    /// unreadable record in place while input is blocked by it.
    pub fn sync(&self, state: &InputState, display: Option<&str>) -> io::Result<()> {
        if state.blocked().is_some() {
            return Ok(());
        }
        let releases = state.recorded();
        if releases.is_empty() {
            return match fs::remove_file(&self.path) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
                _ => Ok(()),
            };
        }
        let record = Record {
            version: VERSION,
            display: display.map(str::to_owned),
            saved_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_secs()),
            releases,
        };
        let dir = self.path.parent().unwrap_or(Path::new("."));
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        // Write beside the record and rename over it, so a reader never sees half a file.
        let staging = self.path.with_extension("json.tmp");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&staging)?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.write_all(&serde_json::to_vec(&record).map_err(io::Error::other)?)?;
        file.sync_all()?;
        fs::rename(&staging, &self.path)
    }
    fn block(&self, state: &InputState, cause: &str) {
        state.block(format!(
            "Refusing physical input: the owed-release record {} is unreadable ({cause}). Check that no key or button is stuck, then remove it.",
            self.path.display()
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A record location in a fresh directory, removed on drop.
    struct Scratch(DebtFile, PathBuf);
    impl std::ops::Deref for Scratch {
        type Target = DebtFile;
        fn deref(&self) -> &DebtFile {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.1);
        }
    }
    fn scratch() -> Scratch {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "linux-bridge-debt-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        Scratch(DebtFile::at(dir.join("nested").join(FILE_NAME)), dir)
    }

    const CONTROL: RecordedRelease = RecordedRelease {
        button: false,
        detail: 37,
        ambiguous: false,
    };
    const BUTTON: RecordedRelease = RecordedRelease {
        button: true,
        detail: 1,
        ambiguous: true,
    };

    #[test]
    fn owed_releases_survive_a_restart_privately() {
        let file = scratch();
        let state = InputState::default();
        state.restore(&[CONTROL, BUTTON]);
        file.sync(&state, Some(":0")).unwrap();
        let mode = fs::metadata(file.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let dir_mode = fs::metadata(file.path().parent().unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(dir_mode & 0o777, 0o700);

        let restarted = InputState::default();
        file.load_into(&restarted, Some(":0"));
        assert_eq!(restarted.recorded(), [CONTROL, BUTTON]);
        assert_eq!(restarted.unconfirmed_releases(), ["keycode 37", "button 1"]);

        // Settled: the record goes away, and a missing record is no debt.
        file.sync(&InputState::default(), Some(":0")).unwrap();
        assert!(!file.path().exists());
        let fresh = InputState::default();
        file.load_into(&fresh, Some(":0"));
        assert!(fresh.recorded().is_empty() && fresh.blocked().is_none());
    }

    #[test]
    fn releases_owed_on_another_display_are_never_resent() {
        let file = scratch();
        let state = InputState::default();
        state.restore(&[CONTROL]);
        file.sync(&state, Some(":0")).unwrap();
        let elsewhere = InputState::default();
        file.load_into(&elsewhere, Some(":1"));
        assert_eq!(
            elsewhere.recorded(),
            [RecordedRelease {
                ambiguous: true,
                ..CONTROL
            }]
        );
    }

    #[test]
    fn an_unreadable_record_blocks_input_and_is_kept() {
        for text in [
            "not json",
            r#"{"version":9,"display":null,"savedAt":0,"releases":[]}"#,
        ] {
            let file = scratch();
            fs::create_dir_all(file.path().parent().unwrap()).unwrap();
            fs::write(file.path(), text).unwrap();
            let state = InputState::default();
            file.load_into(&state, None);
            let reason = state.blocked().expect("blocked");
            assert!(
                reason.contains(&file.path().display().to_string()),
                "{reason}"
            );
            file.sync(&state, None).unwrap();
            assert_eq!(fs::read_to_string(file.path()).unwrap(), text);
        }
        // A record that is a directory cannot be read either.
        let file = scratch();
        fs::create_dir_all(file.path()).unwrap();
        let state = InputState::default();
        file.load_into(&state, None);
        assert!(state.blocked().is_some());
    }

    #[test]
    fn the_location_follows_the_runtime_then_cache_then_home_directory() {
        let locate = |vars: &[(&str, &str)]| {
            let vars = vars
                .iter()
                .map(|&(k, v)| (k.to_owned(), OsString::from(v)))
                .collect::<Vec<_>>();
            DebtFile::locate_with(|name| {
                vars.iter()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.clone())
            })
            .map(|file| file.path().to_owned())
        };
        let all = [
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
            ("XDG_CACHE_HOME", "/cache"),
            ("HOME", "/home/u"),
        ];
        assert_eq!(
            locate(&all),
            Some(PathBuf::from(
                "/run/user/1000/pi-computer-use/linux-input-debt.json"
            ))
        );
        assert_eq!(
            locate(&[("XDG_RUNTIME_DIR", "relative"), all[1], all[2]]),
            Some(PathBuf::from(
                "/cache/pi-computer-use/linux-input-debt.json"
            ))
        );
        assert_eq!(
            locate(&all[2..]),
            Some(PathBuf::from(
                "/home/u/.cache/pi-computer-use/linux-input-debt.json"
            ))
        );
        assert_eq!(locate(&[]), None);
        assert!(DebtFile::locate().is_some(), "tests run with HOME set");
    }
}
