//! Keeps the daemon sidecar running: spawn it, wait, restart with backoff, stop it on quit.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crate::connection::read_runtime_info;

/// The first restart delay after a crash; each further crash doubles it.
pub const BACKOFF_BASE: Duration = Duration::from_millis(500);
/// The longest wait between restarts.
pub const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// A daemon that ran this long before exiting counts as healthy; the backoff starts over.
pub const HEALTHY_UPTIME: Duration = Duration::from_secs(60);
/// How long a daemon may take to write a `daemon.json` that names it before it counts as hung.
pub const START_DEADLINE: Duration = Duration::from_mins(10);
/// The longest start deadline, however many hung starts came before.
pub const START_DEADLINE_MAX: Duration = Duration::from_mins(80);
/// The daemon's exit code when another daemon already holds the data directory.
pub const EXIT_ALREADY_RUNNING: i32 = 2;
/// The daemon's exit code when its database's migrations disagree with the ones it ships.
/// Restarting can't fix that, so the supervisor stops.
pub const EXIT_SCHEMA_MISMATCH: i32 = 3;
/// The daemon's exit code when it refuses its configuration, such as a bad `TENDB_WORKTREE_ROOT`.
/// A restart would meet the same setting, so the supervisor stops.
pub const EXIT_REFUSED_CONFIG: i32 = 4;
/// How long Quit waits for the daemon to exit before killing it. Its own shutdown stops every live
/// session, each with up to 5 s for an interrupt and 5 s more after an abort, so this leaves room
/// for several sessions; killing earlier would orphan `claude` children and leave `daemon.json` behind.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(200);
/// How often the daemon that holds the data directory is looked at while this shell waits for it.
const HOLDER_POLL: Duration = Duration::from_secs(1);
/// How long that holder may go without a /health answer before this shell starts its own daemon,
/// whose instance lock then decides whether the holder is replaced.
const HOLDER_SILENCE: Duration = Duration::from_secs(30);
/// How often the supervisor's own daemon is asked for /health once it serves.
const HEALTH_INTERVAL: Duration = Duration::from_secs(5);
/// How long that daemon may stay silent on /health before it is killed and replaced, when no freeze
/// kill came in the last `FREEZE_WINDOW`. Each one in the window doubles it, up to `FROZEN_AFTER_MAX`,
/// so a freeze that would end by itself gets to end, and a daemon truly wedged is still replaced.
pub const FROZEN_AFTER: Duration = Duration::from_secs(30);
/// The longest a daemon may stay silent before it is killed, however many freeze kills came before.
pub const FROZEN_AFTER_MAX: Duration = Duration::from_mins(8);
/// A freeze kill this long after the last one starts the threshold over.
pub const FREEZE_WINDOW: Duration = Duration::from_mins(10);
/// How long a killed daemon gets to exit before the supervisor moves on without collecting it.
const KILL_WAIT: Duration = Duration::from_secs(5);
/// How long one /health probe may take to connect, and again to answer.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
/// The daemon's liveness route, the same one its instance lock probes.
const HEALTH_PATH: &str = "/health";
/// What a healthy daemon's /health reply starts with.
const HEALTH_OK: &[u8; 12] = b"HTTP/1.1 200";
const LOCK_FILE: &str = "daemon.lock";
/// Written beside `daemon.lock` just before a frozen daemon is killed, so the next daemon knows the
/// restart was this shell's kill and not a crash. Its name and shape match `FROZEN_KILL_FILE` in
/// `apps/daemon/src/daemon/frozen-kill.ts`.
const FROZEN_KILL_FILE: &str = "daemon.frozen-kill";
const LOGS_DIR: &str = "logs";
const SIDECAR_LOG: &str = "sidecar.log";
/// Development and test settings of the daemon; a value in the shell's own environment must not
/// reach the packaged daemon (a fixed UI token, scripted sessions, a live-Claude, live-Codex or live-browser test
/// run, an addon path that only fits another layout). `TENDB_DEV_UI_ORIGIN` is not among them: it
/// is how the builder opts a loopback dev UI in to the installed app's daemon, which still asks for
/// its token.
const DEV_ONLY_VARS: [&str; 6] = [
    "TENDB_DEV_UI_TOKEN",
    "TENDB_FAKE_SCRIPTS",
    "TENDB_LIVE_BROWSER",
    "TENDB_LIVE_CLAUDE",
    "TENDB_LIVE_CODEX",
    "TENDB_SQLITE_BINDING",
];

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

/// The freeze kills of the last `FREEZE_WINDOW`, and the silence they allow the next daemon.
#[derive(Debug, Clone, Default)]
pub struct FreezeKills {
    last: Option<Instant>,
    count: u32,
}

impl FreezeKills {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            last: None,
            count: 0,
        }
    }

    /// The kills that still count at `now`: none once the last is `FREEZE_WINDOW` old.
    fn counted(&self, now: Instant) -> u32 {
        match self.last {
            Some(last) if now.saturating_duration_since(last) < FREEZE_WINDOW => self.count,
            _ => 0,
        }
    }

    /// Notes a freeze kill at `now`.
    pub fn record(&mut self, now: Instant) {
        self.count = self.counted(now).saturating_add(1);
        self.last = Some(now);
    }

    /// How long a daemon started at `now` may stay silent on /health before it is killed.
    #[must_use]
    pub fn frozen_after(&self, now: Instant) -> Duration {
        let factor = 2_u32.saturating_pow(self.counted(now));
        FROZEN_AFTER.saturating_mul(factor).min(FROZEN_AFTER_MAX)
    }
}

/// Leaves the freeze-kill marker for the next daemon: written whole, then renamed into place.
fn write_frozen_marker(data_dir: &Path, pid: u32, frozen_after: Duration) -> io::Result<()> {
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis();
    let marker = serde_json::json!({
        "pid": pid,
        "at": u64::try_from(at).map_err(io::Error::other)?,
        "frozenAfterMs": u64::try_from(frozen_after.as_millis()).map_err(io::Error::other)?,
    });
    let path = data_dir.join(FROZEN_KILL_FILE);
    let staged = data_dir.join(format!("{FROZEN_KILL_FILE}.tmp"));
    fs::write(&staged, marker.to_string())?;
    fs::rename(&staged, &path)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitPolicy {
    Restart,
    /// Another daemon holds the data directory: watch it, and start again once it is gone or silent.
    WaitForHolder,
    Stop,
}

/// What to do when the daemon exits with `code` (`None` when a signal killed it).
#[must_use]
pub const fn exit_policy(code: Option<i32>, quitting: bool) -> ExitPolicy {
    if quitting {
        return ExitPolicy::Stop;
    }
    match code {
        Some(0 | EXIT_SCHEMA_MISMATCH | EXIT_REFUSED_CONFIG) => ExitPolicy::Stop,
        Some(EXIT_ALREADY_RUNNING) => ExitPolicy::WaitForHolder,
        _ => ExitPolicy::Restart,
    }
}

/// Whether a `ps` state column says the process holds nothing any more: a zombie (`Z` first) or one
/// that is exiting (`E`). An empty column is no answer, so it is not gone.
#[must_use]
pub fn stat_means_gone(stat: &str) -> bool {
    stat.starts_with('Z') || stat.contains('E')
}

/// True only on proof that `pid` no longer runs: `ps` printed a zombie or exiting state, or exited
/// 1 with no row (no such process). A `ps` that could not run, died or printed nothing says nothing.
fn process_gone(pid: u32) -> bool {
    let Ok(output) = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .output()
    else {
        return false;
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stat = stdout.split_whitespace().next().unwrap_or_default();
    match output.status.code() {
        Some(0) => stat_means_gone(stat),
        Some(1) => stat.is_empty(),
        _ => false,
    }
}

/// Whether the daemon on loopback `port` answers `GET /health` with a 200 in time.
fn health_answers(port: u16) -> bool {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, HEALTH_TIMEOUT) else {
        return false;
    };
    if stream.set_read_timeout(Some(HEALTH_TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(HEALTH_TIMEOUT)).is_err()
    {
        return false;
    }
    let request = format!(
        "GET {HEALTH_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut status = [0_u8; HEALTH_OK.len()];
    stream.read_exact(&mut status).is_ok() && &status == HEALTH_OK
}

/// The pid in `daemon.lock`, or `None` when the file is absent or holds no pid.
fn lock_holder(data_dir: &Path) -> Option<u32> {
    let text = fs::read_to_string(data_dir.join(LOCK_FILE)).ok()?;
    text.trim().parse().ok().filter(|pid| *pid > 0)
}

/// Blocks while another daemon holds the data directory and is healthy. Returns when a daemon of
/// this shell's own may be tried: the lock is free, its holder is gone, the holder has not answered
/// /health as the daemon `daemon.json` names for `HOLDER_SILENCE`, or the shell is quitting. It
/// never signals the holder; the new daemon's instance lock decides whether to replace it.
fn wait_for_holder(shared: &Mutex<Shared>, data_dir: &Path, log_dir: &Path) {
    report(
        log_dir,
        "another daemon holds the data directory; watching it",
    );
    let mut last_answer = Instant::now();
    loop {
        thread::sleep(HOLDER_POLL);
        if lock(shared).quitting {
            return;
        }
        let Some(holder) = lock_holder(data_dir) else {
            break;
        };
        if process_gone(holder) {
            break;
        }
        if let Some((pid, port)) = read_runtime_info(data_dir)
            && pid == holder
            && health_answers(port)
        {
            last_answer = Instant::now();
        }
        if last_answer.elapsed() >= HOLDER_SILENCE {
            break;
        }
    }
    report(log_dir, "the other daemon is gone or silent; starting one");
}

#[derive(Debug, Default)]
struct Shared {
    child: Option<Child>,
    /// The write end of the daemon's stdin. Dropping it, or the shell dying, closes the pipe, which
    /// tells the daemon to shut down.
    stdin: Option<ChildStdin>,
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
    log_dir: PathBuf,
}

impl Supervisor {
    /// Starts the daemon from `<resource_dir>/daemon/daemon.mjs` with the bundled Node binary,
    /// appending its output to `<data_dir>/logs/sidecar.log`. `data_dir` is the daemon's data
    /// directory, where its `daemon.lock` and `daemon.json` are read.
    #[must_use]
    pub fn start(resource_dir: PathBuf, data_dir: PathBuf) -> Self {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let worker = Arc::clone(&shared);
        let log_dir = data_dir.join(LOGS_DIR);
        let worker_log_dir = log_dir.clone();
        thread::spawn(move || run_loop(&worker, &resource_dir, &data_dir, &worker_log_dir));
        Self { shared, log_dir }
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
            report(
                &self.log_dir,
                &format!("could not signal the daemon: {error}"),
            );
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
            report(
                &self.log_dir,
                &format!("could not kill the daemon: {error}"),
            );
        }
    }
}

/// The start deadline after `hung` consecutive hung starts: doubling from `START_DEADLINE`, capped.
pub fn start_deadline(hung: u32) -> Duration {
    let doublings = 1_u32.checked_shl(hung).unwrap_or(u32::MAX);
    START_DEADLINE
        .saturating_mul(doublings)
        .min(START_DEADLINE_MAX)
}

/// How a supervised daemon ended, as `run_loop` needs it.
#[derive(Debug, Default, Clone, Copy)]
struct ChildEnd {
    code: Option<i32>,
    /// This shell killed it for staying silent on /health while serving.
    killed_as_frozen: bool,
    /// This shell killed it for not finishing its start in time.
    killed_as_start_hung: bool,
    /// It wrote a `daemon.json` naming its pid at some point: it finished starting.
    served: bool,
}

fn run_loop(shared: &Mutex<Shared>, resource_dir: &Path, data_dir: &Path, log_dir: &Path) {
    let mut backoff = Backoff::new(BACKOFF_BASE, BACKOFF_MAX);
    let mut freezes = FreezeKills::new();
    // Consecutive starts killed for hanging; a start that finished resets it.
    let mut hung_starts: u32 = 0;
    loop {
        {
            let mut guard = lock(shared);
            if guard.quitting {
                return;
            }
            guard.spawning = true;
        }
        let started = Instant::now();
        let frozen_after = freezes.frozen_after(started);
        let spawned = spawn_daemon(resource_dir, log_dir);
        let end = {
            let mut guard = lock(shared);
            guard.spawning = false;
            match spawned {
                Ok(mut child) => {
                    // Stored under the same lock that clears `spawning`: a concurrent `stop` sees the child.
                    guard.stdin = child.stdin.take();
                    guard.child = Some(child);
                    drop(guard);
                    wait_for_exit(
                        shared,
                        data_dir,
                        log_dir,
                        frozen_after,
                        start_deadline(hung_starts),
                    )
                }
                Err(error) => {
                    drop(guard);
                    report(log_dir, &format!("could not start the daemon: {error}"));
                    ChildEnd::default()
                }
            }
        };
        if end.killed_as_frozen {
            freezes.record(Instant::now());
        }
        if end.killed_as_start_hung {
            hung_starts = hung_starts.saturating_add(1);
        } else if end.served {
            hung_starts = 0;
        }
        let quitting = lock(shared).quitting;
        match exit_policy(end.code, quitting) {
            ExitPolicy::Stop => return,
            ExitPolicy::WaitForHolder => {
                // The wait is the delay: no backoff on top of it.
                wait_for_holder(shared, data_dir, log_dir);
                continue;
            }
            ExitPolicy::Restart => {}
        }
        // A start-hang kill ran long but was not healthy.
        if started.elapsed() >= HEALTHY_UPTIME && !end.killed_as_start_hung {
            backoff.reset();
        }
        thread::sleep(backoff.next_delay());
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildHealth {
    /// Answering, not yet serving, or not silent for long enough to judge.
    Fine,
    /// No longer running, though its exit has not been collected: a daemon that takes minutes to
    /// tear down stays unreaped that long.
    Gone,
    /// Running, but silent on /health for its `frozen_after`.
    Frozen,
    /// Running, but no `daemon.json` has named it within its start deadline.
    StartHung,
}

/// Probes the child's /health once it serves, so a daemon that froze or is slow to die is replaced.
#[derive(Debug)]
struct HealthWatch {
    last_check: Instant,
    /// When the child last answered, or when it was first found silent. `None` until then: a daemon
    /// that is still starting has no `daemon.json` and is never judged.
    last_answer: Option<Instant>,
    /// How long the child may stay silent before it counts as frozen.
    frozen_after: Duration,
    spawned: Instant,
    /// How long after `spawned` the child may go without a `daemon.json` naming it.
    start_deadline: Duration,
    /// A `daemon.json` has named the child: from then on only the freeze watch applies.
    served: bool,
}

impl HealthWatch {
    fn new(frozen_after: Duration, start_deadline: Duration) -> Self {
        Self {
            last_check: Instant::now(),
            last_answer: None,
            frozen_after,
            spawned: Instant::now(),
            start_deadline,
            served: false,
        }
    }

    fn check(&mut self, pid: u32, data_dir: &Path) -> ChildHealth {
        if self.last_check.elapsed() < HEALTH_INTERVAL {
            return ChildHealth::Fine;
        }
        self.last_check = Instant::now();
        let info = read_runtime_info(data_dir).filter(|&(named, _)| named == pid);
        let Some((_, port)) = info else {
            if !self.served && self.spawned.elapsed() >= self.start_deadline && !process_gone(pid) {
                return ChildHealth::StartHung;
            }
            return ChildHealth::Fine;
        };
        self.served = true;
        if health_answers(port) {
            self.last_answer = Some(Instant::now());
            return ChildHealth::Fine;
        }
        if process_gone(pid) {
            return ChildHealth::Gone;
        }
        let silent_since = *self.last_answer.get_or_insert_with(Instant::now);
        if silent_since.elapsed() >= self.frozen_after {
            ChildHealth::Frozen
        } else {
            ChildHealth::Fine
        }
    }
}

/// Stops tracking a child that is gone or frozen, killing it first when `kill` is set, and returns
/// its exit code when it could be collected within `wait`. A child still unreaped then is handed to
/// a thread that waits for it, so the supervisor can start the next daemon now.
fn release_child(
    shared: &Mutex<Shared>,
    log_dir: &Path,
    kill: bool,
    wait: Duration,
) -> Option<i32> {
    let deadline = Instant::now() + wait;
    let mut kill = kill;
    loop {
        {
            let mut guard = lock(shared);
            let child = guard.child.as_mut()?;
            if kill {
                kill = false;
                if let Err(error) = child.kill() {
                    report(log_dir, &format!("could not kill the daemon: {error}"));
                }
            }
            if let Ok(Some(status)) = child.try_wait() {
                guard.child = None;
                guard.stdin = None;
                return status.code();
            }
            if Instant::now() >= deadline {
                guard.stdin = None;
                if let Some(mut child) = guard.child.take() {
                    thread::spawn(move || {
                        // Only to reap it; how it ended no longer matters.
                        let _ = child.wait();
                    });
                }
                return None;
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
}

/// Polls rather than blocking in `wait`, so `stop` can take the lock to signal the child. Between
/// polls it watches the child's health: the mutex is free while a probe runs. Answers the child's exit
/// code, whether this shell killed it (as frozen or as hung in its start), and whether it served.
fn wait_for_exit(
    shared: &Mutex<Shared>,
    data_dir: &Path,
    log_dir: &Path,
    frozen_after: Duration,
    start_deadline: Duration,
) -> ChildEnd {
    let mut watch = HealthWatch::new(frozen_after, start_deadline);
    loop {
        let pid = {
            let guard = lock(shared);
            // A daemon told to stop closes its server before it exits; that silence is not a freeze.
            if guard.quitting {
                None
            } else {
                guard.child.as_ref().map(Child::id)
            }
        };
        let health = pid.map_or(ChildHealth::Fine, |pid| watch.check(pid, data_dir));
        if health != ChildHealth::Fine && !lock(shared).quitting {
            return match health {
                ChildHealth::Frozen => {
                    report(
                        log_dir,
                        &format!(
                            "the daemon stopped answering /health for {} s; killing it to start another",
                            frozen_after.as_secs()
                        ),
                    );
                    // Before the kill, so the next daemon never starts without it.
                    if let Some(pid) = pid
                        && let Err(error) = write_frozen_marker(data_dir, pid, frozen_after)
                    {
                        report(
                            log_dir,
                            &format!("could not write the freeze-kill marker: {error}"),
                        );
                    }
                    ChildEnd {
                        code: release_child(shared, log_dir, true, KILL_WAIT),
                        killed_as_frozen: true,
                        served: watch.served,
                        ..ChildEnd::default()
                    }
                }
                ChildHealth::StartHung => {
                    report(
                        log_dir,
                        &format!(
                            "the daemon did not finish starting in {} min; killing it to start another",
                            start_deadline.as_secs() / 60
                        ),
                    );
                    // No freeze-kill marker: no serving daemon froze.
                    ChildEnd {
                        code: release_child(shared, log_dir, true, KILL_WAIT),
                        killed_as_start_hung: true,
                        ..ChildEnd::default()
                    }
                }
                ChildHealth::Gone | ChildHealth::Fine => {
                    report(log_dir, "the daemon is gone; starting another");
                    ChildEnd {
                        code: release_child(shared, log_dir, false, Duration::ZERO),
                        served: watch.served,
                        ..ChildEnd::default()
                    }
                }
            };
        }
        {
            let mut guard = lock(shared);
            let Some(child) = guard.child.as_mut() else {
                return ChildEnd {
                    served: watch.served,
                    ..ChildEnd::default()
                };
            };
            let status = child.try_wait();
            match status {
                Ok(Some(status)) => {
                    guard.child = None;
                    guard.stdin = None;
                    return ChildEnd {
                        code: status.code(),
                        served: watch.served,
                        ..ChildEnd::default()
                    };
                }
                Ok(None) => {}
                Err(error) => {
                    report(log_dir, &format!("lost track of the daemon: {error}"));
                    guard.child = None;
                    guard.stdin = None;
                    return ChildEnd {
                        served: watch.served,
                        ..ChildEnd::default()
                    };
                }
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
}

/// Prints `message` and appends it to the sidecar log, where a packaged app's user can find it.
fn report(log_dir: &Path, message: &str) {
    eprintln!("10db: {message}");
    let written = fs::create_dir_all(log_dir)
        .and_then(|()| {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_dir.join(SIDECAR_LOG))
        })
        .and_then(|mut log| writeln!(log, "10db shell: {message}"));
    if let Err(error) = written {
        eprintln!("10db: could not write the sidecar log: {error}");
    }
}

/// The command that runs the daemon bundle `entry` with the bundled Node binary `node`.
fn daemon_command(node: &Path, entry: &Path) -> Command {
    let mut command = Command::new(node);
    command
        .arg(entry)
        // Port 0: the daemon picks a free port and announces it in daemon.json.
        .env("TENDB_PORT", "0")
        .env("TENDB_PARENT_STDIN", "1")
        .stdin(Stdio::piped());
    for name in DEV_ONLY_VARS {
        command.env_remove(name);
    }
    command
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
        .open(log_dir.join(SIDECAR_LOG))?;
    daemon_command(&node, &entry)
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
    fn the_start_deadline_doubles_per_hung_start_and_caps_at_the_max() {
        let minutes: Vec<u64> = [0, 1, 2, 3, 4, 1_000, u32::MAX]
            .iter()
            .map(|&hung| start_deadline(hung).as_secs() / 60)
            .collect();
        assert_eq!(minutes, [10, 20, 40, 80, 80, 80, 80]);
    }

    #[test]
    fn backoff_never_overflows() {
        let mut backoff = Backoff::new(BACKOFF_BASE, BACKOFF_MAX);
        for _ in 0..100 {
            assert!(backoff.next_delay() <= BACKOFF_MAX);
        }
    }

    #[test]
    fn each_freeze_kill_in_the_window_doubles_the_threshold_up_to_the_max_and_a_quiet_window_starts_over()
     {
        let start = Instant::now();
        let mut freezes = FreezeKills::new();
        let mut now = start;
        let mut thresholds = vec![freezes.frozen_after(now).as_secs()];
        for _ in 0..5 {
            now += Duration::from_secs(60);
            freezes.record(now);
            thresholds.push(freezes.frozen_after(now).as_secs());
        }
        assert_eq!(thresholds, [30, 60, 120, 240, 480, 480]);
        // Ten quiet minutes after the last kill, the next daemon gets the base again.
        let quiet = now + FREEZE_WINDOW;
        assert_eq!(freezes.frozen_after(quiet), FROZEN_AFTER);
        freezes.record(quiet);
        assert_eq!(freezes.frozen_after(quiet), Duration::from_secs(60));
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
        // Another daemon owns the data directory: watch it, and start again once it is gone.
        assert_eq!(
            exit_policy(Some(EXIT_ALREADY_RUNNING), false),
            ExitPolicy::WaitForHolder
        );
        assert_eq!(
            exit_policy(Some(EXIT_ALREADY_RUNNING), true),
            ExitPolicy::Stop
        );
        // The database needs the builder: a restart would meet the same migrations.
        assert_eq!(
            exit_policy(Some(EXIT_SCHEMA_MISMATCH), false),
            ExitPolicy::Stop
        );
        // A refused setting, such as a bad TENDB_WORKTREE_ROOT, is refused again on every start.
        assert_eq!(
            exit_policy(Some(EXIT_REFUSED_CONFIG), false),
            ExitPolicy::Stop
        );
        // Quitting wins over everything.
        assert_eq!(exit_policy(Some(1), true), ExitPolicy::Stop);
        assert_eq!(exit_policy(None, true), ExitPolicy::Stop);
    }

    #[test]
    fn a_zombie_or_exiting_state_means_gone_and_an_unreadable_one_does_not() {
        for stat in ["Z", "Z+", "SsE", "E"] {
            assert!(stat_means_gone(stat), "{stat} is gone");
        }
        for stat in ["Ss", "R+", "T", ""] {
            assert!(!stat_means_gone(stat), "{stat:?} is not gone");
        }
    }

    #[test]
    fn the_daemon_command_watches_the_shell_and_drops_dev_settings() {
        let command = daemon_command(Path::new("/node"), Path::new("/daemon.mjs"));
        let envs: Vec<_> = command.get_envs().collect();
        let value = |name: &str| envs.iter().find(|(key, _)| *key == name).map(|(_, v)| *v);
        assert_eq!(value("TENDB_PORT"), Some(Some(std::ffi::OsStr::new("0"))));
        assert_eq!(
            value("TENDB_PARENT_STDIN"),
            Some(Some(std::ffi::OsStr::new("1")))
        );
        for name in [
            "TENDB_DEV_UI_TOKEN",
            "TENDB_FAKE_SCRIPTS",
            "TENDB_LIVE_BROWSER",
            "TENDB_LIVE_CLAUDE",
            "TENDB_LIVE_CODEX",
            "TENDB_SQLITE_BINDING",
        ] {
            // `Some(None)` is an explicit removal from the inherited environment.
            assert_eq!(value(name), Some(None), "{name} must be removed");
        }
        // The builder's opt-in to a live dev UI over the factory's daemon is inherited untouched;
        // the daemon itself accepts only a loopback http origin.
        assert_eq!(value("TENDB_DEV_UI_ORIGIN"), None);
    }
}
