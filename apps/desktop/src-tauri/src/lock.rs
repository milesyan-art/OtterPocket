//! `library.lock` tells other computers that a library is open here, so two computers sharing one
//! folder through iCloud Drive or Dropbox don't write to `library.db` at the same time.
//!
//! The lock is advisory: it is refreshed every minute while the library is open and removed when it
//! closes. A lock that stopped being refreshed belongs to a computer that quit without cleaning up
//! (a crash, a dead battery), so it is taken over without asking.

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

pub const LOCK_FILE: &str = "library.lock";
const HEARTBEAT: Duration = Duration::from_secs(60);
/// Three missed heartbeats: long enough for a sync service to carry the file between computers.
const STALE_AFTER_MS: i64 = 3 * 60 * 1000;

/// This installation of the app, as recorded in the lock.
#[derive(Debug, Clone)]
pub struct LockOwner {
    /// Random id created on first launch; tells two computers apart even when they share a name.
    pub device_id: String,
    /// Shown to the user on the other computer ("open on Alex's MacBook Pro").
    pub computer: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockRecord {
    device: String,
    computer: String,
    /// Unique to one opening of the library, so closing an old handle never removes a newer lock.
    session: String,
    updated_at: i64,
}

#[derive(Debug)]
pub enum LockError {
    /// Another computer refreshed the lock recently.
    InUse { computer: String, last_seen: i64 },
    Io(io::Error),
}

/// Held while a library is open; dropping it stops the heartbeat and removes the lock file.
pub struct LockFile {
    path: PathBuf,
    session: String,
    stop: Arc<AtomicBool>,
    heartbeat: Option<thread::JoinHandle<()>>,
}

impl LockFile {
    /// Claims the library at `root`. Refuses when another computer holds a fresh lock, unless `force`.
    pub fn acquire(root: &Path, owner: &LockOwner, force: bool) -> Result<Self, LockError> {
        let path = root.join(LOCK_FILE);
        if !force
            && let Some(other) = read(&path)
            && other.device != owner.device_id
            && (now() - other.updated_at).abs() < STALE_AFTER_MS
        {
            return Err(LockError::InUse { computer: other.computer, last_seen: other.updated_at });
        }

        let session = uuid::Uuid::new_v4().to_string();
        let record = LockRecord {
            device: owner.device_id.clone(),
            computer: owner.computer.clone(),
            session: session.clone(),
            updated_at: now(),
        };
        write(&path, &record).map_err(LockError::Io)?;

        let stop = Arc::new(AtomicBool::new(false));
        let heartbeat = {
            let (path, stop) = (path.clone(), stop.clone());
            let mut record = record;
            thread::Builder::new().name("library-lock".into()).spawn(move || {
                loop {
                    thread::park_timeout(HEARTBEAT);
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    // Someone opened the library anyway, or the folder moved: stop touching it.
                    if read(&path).is_none_or(|current| current.session != record.session) {
                        break;
                    }
                    record.updated_at = now();
                    let _ = write(&path, &record);
                }
            })
        }
        .ok();

        Ok(Self { path, session, stop, heartbeat })
    }
}

impl Drop for LockFile {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.thread().unpark();
            let _ = heartbeat.join();
        }
        if read(&self.path).is_some_and(|current| current.session == self.session) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn read(path: &Path) -> Option<LockRecord> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Write-then-rename, so a reader on this or another computer never sees half a file.
fn write(path: &Path, record: &LockRecord) -> io::Result<()> {
    let tmp = path.with_extension(format!("lock.{}.tmp", std::process::id()));
    fs::write(&tmp, serde_json::to_vec(record).map_err(io::Error::other)?)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(device: &str) -> LockOwner {
        LockOwner { device_id: device.into(), computer: format!("{device}'s Mac") }
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("otter-pocket-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_record(dir: &Path, device: &str, updated_at: i64) {
        let record = LockRecord { device: device.into(), computer: "Studio iMac".into(), session: "s".into(), updated_at };
        write(&dir.join(LOCK_FILE), &record).unwrap();
    }

    #[test]
    fn fresh_lock_from_another_computer_blocks_unless_forced() {
        let dir = temp_dir();
        write_record(&dir, "other", now() - 30_000);
        match LockFile::acquire(&dir, &owner("me"), false) {
            Err(LockError::InUse { computer, .. }) => assert_eq!(computer, "Studio iMac"),
            other => panic!("expected InUse, got {:?}", other.err()),
        }
        let lock = LockFile::acquire(&dir, &owner("me"), true).unwrap();
        assert_eq!(read(&dir.join(LOCK_FILE)).unwrap().device, "me");
        drop(lock);
        assert!(!dir.join(LOCK_FILE).exists(), "closing removes our lock");
    }

    #[test]
    fn stale_or_own_locks_are_taken_over() {
        let dir = temp_dir();
        write_record(&dir, "other", now() - STALE_AFTER_MS - 1000);
        drop(LockFile::acquire(&dir, &owner("me"), false).unwrap());
        write_record(&dir, "me", now());
        drop(LockFile::acquire(&dir, &owner("me"), false).unwrap());
    }

    #[test]
    fn closing_an_old_handle_keeps_a_newer_lock() {
        let dir = temp_dir();
        let first = LockFile::acquire(&dir, &owner("me"), false).unwrap();
        let second = LockFile::acquire(&dir, &owner("me"), false).unwrap();
        drop(first);
        assert!(dir.join(LOCK_FILE).exists(), "the second opening still owns the lock");
        drop(second);
        assert!(!dir.join(LOCK_FILE).exists());
    }
}
