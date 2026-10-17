//! Keeps the daemon sidecar running: spawn it, wait, restart with backoff, stop it on quit.

use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

/// The first restart delay after a crash; each further crash doubles it.
pub const BACKOFF_BASE: Duration = Duration::from_millis(500);
/// The longest wait between restarts.
pub const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// A daemon that ran this long before exiting counts as healthy; the backoff starts over.
pub const HEALTHY_UPTIME: Duration = Duration::from_secs(60);
/// The daemon's exit code when another daemon already holds the data directory.
pub const EXIT_ALREADY_RUNNING: i32 = 2;
/// How long Quit waits for the daemon to exit before killing it. Its own shutdown stops every live
/// session, each with up to 5 s for an interrupt and 5 s more after an abort, so this leaves room
/// for several sessions; killing earlier would orphan `claude` children and leave `daemon.json` behind.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Doubling restart delay, capped.
#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    max: Duration,
    attempt: u32,
}

impl Backoff {
    #[must_use]
    pub const fn new(base: Duration, max: Duration) -> Self {
        Self {
            base,
            max,
            attempt: 0,
        }
    }

    /// The delay before the next restart; each call doubles the following one.
    pub fn next_delay(&mut self) -> Duration {
        let factor = 2_u32.saturating_pow(self.attempt);
        self.attempt = self.attempt.saturating_add(1);
        self.base.saturating_mul(factor).min(self.max)
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitPolicy {
    Restart,
    Stop,
}

/// What to do when the daemon exits with `code` (`None` when a signal killed it).
#[must_use]
pub const fn exit_policy(code: Option<i32>, quitting: bool) -> ExitPolicy {
    if quitting {
        return ExitPolicy::Stop;
    }
    match code {
        Some(0 | EXIT_ALREADY_RUNNING) => ExitPolicy::Stop,
        _ => ExitPolicy::Restart,
    }
}

#[derive(Debug, Default)]
struct Shared {
    child: Option<Child>,
    quitting: bool,
    /// True between deciding to spawn and storing the child, so `stop` can't miss a daemon mid-spawn.
    spawning: bool,
}

fn lock(shared: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs the daemon sidecar on a background thread and restarts it when it crashes.
#[derive(Debug, Clone)]
pub struct Supervisor {
    shared: Arc<Mutex<Shared>>,
}

impl Supervisor {
    /// Starts the daemon from `<resource_dir>/daemon/daemon.mjs` with the bundled Node binary,
    /// appending its output to `<log_dir>/sidecar.log`.
    #[must_use]
    pub fn start(resource_dir: PathBuf, log_dir: PathBuf) -> Self {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let worker = Arc::clone(&shared);
        thread::spawn(move || run_loop(&worker, &resource_dir, &log_dir));
        Self { shared }
    }

    /// Stops restarting, sends SIGTERM so the daemon stops its sessions cleanly, and waits for
    /// it to exit; kills it if it hasn't stopped after `STOP_TIMEOUT`.
    pub fn stop(&self) {
        let deadline = Instant::now() + STOP_TIMEOUT;
        let pid = loop {
            let mut guard = lock(&self.shared);
            guard.quitting = true;
            if !guard.spawning {
                break guard.child.as_ref().map(Child::id);
            }
            drop(guard);
            if Instant::now() >= deadline {
                return;
            }
            thread::sleep(POLL_INTERVAL);
        };
        let Some(pid) = pid else { return };
        if let Err(error) = Command::new("/bin/kill")
            .args(["-TERM", &pid.to_string()])
            .status()
        {
            eprintln!("10db: could not signal the daemon: {error}");
        }
        while Instant::now() < deadline {
            if lock(&self.shared).child.is_none() {
                return;
            }
            thread::sleep(POLL_INTERVAL);
        }
        if let Some(child) = lock(&self.shared).child.as_mut()
            && let Err(error) = child.kill()
        {
            eprintln!("10db: could not kill the daemon: {error}");
        }
    }
}

fn run_loop(shared: &Mutex<Shared>, resource_dir: &Path, log_dir: &Path) {
    let mut backoff = Backoff::new(BACKOFF_BASE, BACKOFF_MAX);
    loop {
        {
            let mut guard = lock(shared);
            if guard.quitting {
                return;
            }
            guard.spawning = true;
        }
        let started = Instant::now();
        let spawned = spawn_daemon(resource_dir, log_dir);
        let code = {
            let mut guard = lock(shared);
            guard.spawning = false;
            match spawned {
                Ok(child) => {
                    // Stored under the same lock that clears `spawning`: a concurrent `stop` sees the child.
                    guard.child = Some(child);
                    drop(guard);
                    wait_for_exit(shared)
                }
                Err(error) => {
                    drop(guard);
                    eprintln!("10db: could not start the daemon: {error}");
                    None
                }
            }
        };
        if exit_policy(code, lock(shared).quitting) == ExitPolicy::Stop {
            return;
        }
        if started.elapsed() >= HEALTHY_UPTIME {
            backoff.reset();
        }
        thread::sleep(backoff.next_delay());
    }
}

/// Polls rather than blocking in `wait`, so `stop` can take the lock to signal the child.
fn wait_for_exit(shared: &Mutex<Shared>) -> Option<i32> {
    loop {
        {
            let mut guard = lock(shared);
            let status = guard.child.as_mut()?.try_wait();
            match status {
                Ok(Some(status)) => {
                    guard.child = None;
                    return status.code();
                }
                Ok(None) => {}
                Err(error) => {
                    eprintln!("10db: lost track of the daemon: {error}");
                    guard.child = None;
                    return None;
                }
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn spawn_daemon(resource_dir: &Path, log_dir: &Path) -> io::Result<Child> {
    let exe = std::env::current_exe()?;
    let node = exe
        .parent()
        .ok_or_else(|| io::Error::other("the app executable has no parent directory"))?
        .join("tendb-node");
    let entry = resource_dir.join("daemon").join("daemon.mjs");
    fs::create_dir_all(log_dir)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("sidecar.log"))?;
    Command::new(node)
        .arg(entry)
        // Port 0: the daemon picks a free port and announces it in daemon.json.
        .env("TENDB_PORT", "0")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn backoff_doubles_from_the_base_and_caps_at_the_max() {
        let mut backoff = Backoff::new(Duration::from_millis(500), Duration::from_secs(30));
        let delays: Vec<u128> = (0..9).map(|_| backoff.next_delay().as_millis()).collect();
        assert_eq!(
            delays,
            vec![
                500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000
            ]
        );
    }

    #[test]
    fn backoff_never_overflows() {
        let mut backoff = Backoff::new(BACKOFF_BASE, BACKOFF_MAX);
        for _ in 0..100 {
            assert!(backoff.next_delay() <= BACKOFF_MAX);
        }
    }

    #[test]
    fn reset_starts_again_from_the_base() {
        let mut backoff = Backoff::new(BACKOFF_BASE, BACKOFF_MAX);
        backoff.next_delay();
        backoff.next_delay();
        backoff.reset();
        assert_eq!(backoff.next_delay(), BACKOFF_BASE);
    }

    #[test]
    fn exit_policy_restarts_crashes_and_stops_otherwise() {
        // A crash (exit 1) or a signal death (kill -9: no code) is restarted.
        assert_eq!(exit_policy(Some(1), false), ExitPolicy::Restart);
        assert_eq!(exit_policy(None, false), ExitPolicy::Restart);
        // A clean shutdown is not.
        assert_eq!(exit_policy(Some(0), false), ExitPolicy::Stop);
        // Another daemon owns the data directory: connect to it instead of looping.
        assert_eq!(
            exit_policy(Some(EXIT_ALREADY_RUNNING), false),
            ExitPolicy::Stop
        );
        // Quitting wins over everything.
        assert_eq!(exit_policy(Some(1), true), ExitPolicy::Stop);
        assert_eq!(exit_policy(None, true), ExitPolicy::Stop);
    }
}
