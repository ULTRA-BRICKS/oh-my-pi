//! Host-death lifeline for the command trees the embedded shell spawns.
//!
//! Every external command the shell launches runs in its own session (see
//! `child_session_action`), so nothing ties it to the host process once the
//! host is gone: a `SIGKILL`, a native abort, or a jetsam kill runs no cleanup
//! code in the dying process, and the orphaned tree keeps running under
//! launchd/init. Ownership therefore has to live outside the host:
//!
//! - [`start`] opens a per-host record file and appends one line for every
//!   command the shell spawns (pid, start-time stamp, group/session
//!   leadership). The record is written as commands spawn, so it outlives any
//!   kind of host death.
//! - It also starts a tiny `/bin/sh` supervisor in its own session, reparented
//!   away from the host, whose stdin is a pipe only the host holds the write
//!   end of. The kernel closes that end however the host dies; the supervisor
//!   then execs the reaper command, which calls [`reap_after_host_exit`].
//! - [`sweep`] (the reaper, and every host startup) terminates what the records
//!   of dead hosts still own: each recorded command, every member of a group or
//!   session it leads, and all their descendants — `SIGTERM`, then `SIGKILL`
//!   for anything still alive.
//!
//! Deliberately detached work is outside that ownership by construction:
//! `nohup cmd &` (brush's `detach_reparent`) is never recorded and leaves the
//! tree, and a process that starts its own session and is reparented away —
//! the double-fork daemon idiom `rig-detached-*` launchers use — belongs to no
//! recorded group, session, or live descendant tree. Processes other omp
//! components spawn directly (launch daemons, LSP servers) are never recorded.

use std::{
	collections::{HashMap, HashSet, VecDeque},
	ffi::{CString, OsStr},
	fs::{self, File, OpenOptions},
	io::{self, BufRead, Write},
	os::{
		fd::{AsRawFd, FromRawFd, OwnedFd},
		unix::ffi::OsStrExt,
	},
	path::{Path, PathBuf},
	sync::{Arc, OnceLock},
	time::{Duration, Instant},
};

use brush_core::SpawnObserver;
use parking_lot::Mutex;

use crate::process::{self, ProcessRow};

/// File extension of an unclaimed host record.
const RECORD_EXTENSION: &str = "lifeline";
/// Infix a reaper appends (with its pid) when it claims a record.
const CLAIM_INFIX: &str = ".reaping-";
/// First token of a record's header line.
const HEADER_TAG: &str = "omp-lifeline";

/// Grace a recorded tree gets to exit on `SIGTERM` before `SIGKILL`.
const TERM_GRACE: Duration = Duration::from_millis(1_000);
/// Wait after each `SIGKILL` wave before rescanning for stragglers.
const KILL_GRACE: Duration = Duration::from_millis(300);
/// Upper bound on one record's signal waves.
const REAP_DEADLINE: Duration = Duration::from_secs(4);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// `POSIX_SPAWN_SETSID`: absent from the `libc` crate on Apple targets.
#[cfg(target_os = "macos")]
const SPAWN_SETSID: libc::c_int = 0x0400;
#[cfg(not(target_os = "macos"))]
const SPAWN_SETSID: libc::c_int = 0x80;
/// Keep the host's other descriptors out of the long-lived supervisor where
/// the platform can; elsewhere they are close-on-exec by construction.
#[cfg(target_os = "macos")]
const SPAWN_CLOEXEC_DEFAULT: libc::c_int = libc::POSIX_SPAWN_CLOEXEC_DEFAULT;
#[cfg(not(target_os = "macos"))]
const SPAWN_CLOEXEC_DEFAULT: libc::c_int = 0;

/// Supervisor body, run by `/bin/sh -c` with `$1` = reaper cwd (may be empty)
/// and the reaper argv after it. The outer shell backgrounds the watcher and
/// exits, so the watcher reparents away from the host at once. An async list
/// gets `/dev/null` as stdin, so the lifeline pipe is moved to fd 3 first.
/// `read` returns non-zero only at EOF: when the host's write end is closed.
const SUPERVISOR_SCRIPT: &str = r#"trap '' HUP INT
exec 3<&0 </dev/null
cwd=$1
shift
(
	while read -r _ <&3; do :; done
	exec 3<&-
	if [ -n "$cwd" ]; then cd "$cwd" || exit 1; fi
	exec "$@"
) &
"#;

/// One process a host recorded when its shell spawned it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Entry {
	pid:           i32,
	start:         u64,
	leads_group:   bool,
	leads_session: bool,
}

/// Pid plus start stamp of a host process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HostIdentity {
	pid:   i32,
	start: u64,
}

/// Processes terminated on behalf of one dead host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReapedHost {
	/// Pid the dead host had.
	pub host_pid:  i32,
	/// Distinct live processes that were signalled.
	pub processes: u32,
}

/// Append handle of this process's record, set once by [`start`].
static RECORD: OnceLock<File> = OnceLock::new();
/// Record path of this process once [`start`] succeeded.
static STARTED: Mutex<Option<PathBuf>> = parking_lot::const_mutex(None);
/// Host end of the supervisor pipe. Never closed: the kernel closes it when
/// this process dies, which is the supervisor's wake-up.
static SUPERVISOR_LIFELINE: OnceLock<OwnedFd> = OnceLock::new();

struct LifelineObserver;

impl SpawnObserver for LifelineObserver {
	fn on_spawn(&self, pid: i32, _pgid: Option<i32>) {
		record_spawn(pid);
	}
}

/// Start recording this host's shell spawns under `dir` and start its
/// supervisor.
///
/// Once this process has died the supervisor runs `reaper` (from `reaper_cwd`
/// when given) with `dir` and this host's record path appended. Idempotent:
/// later calls return the first record path.
///
/// Call it before the shell spawns anything: the supervisor pipe is created
/// without `pipe2` on macOS, so a concurrent fork could inherit the host end.
pub fn start(dir: &Path, reaper: &[String], reaper_cwd: Option<&Path>) -> io::Result<PathBuf> {
	let mut started = STARTED.lock();
	if let Some(path) = started.as_ref() {
		return Ok(path.clone());
	}
	if reaper.is_empty() {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "lifeline reaper command is empty"));
	}
	let host = self_identity()?;
	fs::create_dir_all(dir)?;
	let path = dir.join(format!("{}-{}.{RECORD_EXTENSION}", host.pid, host.start));
	// Append, never truncate: a host that re-execs itself keeps its pid and
	// start stamp, so entries recorded before the exec stay owned.
	let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
	if file.metadata()?.len() == 0 {
		file.write_all(format!("{HEADER_TAG} {} {}\n", host.pid, host.start).as_bytes())?;
	}
	let mut reaper_argv = reaper.to_vec();
	reaper_argv.push(dir.to_string_lossy().into_owned());
	reaper_argv.push(path.to_string_lossy().into_owned());
	let lifeline = spawn_supervisor(&reaper_argv, reaper_cwd)?;
	let _ = SUPERVISOR_LIFELINE.set(lifeline);
	let _ = RECORD.set(file);
	brush_core::set_global_spawn_observer(Arc::new(LifelineObserver));
	*started = Some(path.clone());
	Ok(path)
}

/// Record a process this host spawned for a command (no-op before [`start`]).
/// Spawn paths outside the shell, such as the PTY runner, call this directly.
pub fn record_spawn(pid: i32) {
	let Some(mut file) = RECORD.get() else {
		return;
	};
	let Some(row) = process::process_row(pid) else {
		return;
	};
	// One short `O_APPEND` write per line keeps concurrent spawns intact.
	let _ = file.write_all(format_entry(&row).as_bytes());
}

/// The supervisor's reaper: wait for the host of `record` to exit, then sweep.
///
/// Waits up to `host_exit_wait` for the host to be gone, then runs [`sweep`]
/// on `dir`. A host still alive after the wait (it re-exec'd itself, which
/// also closes the lifeline pipe) is left alone.
pub fn reap_after_host_exit(
	dir: &Path,
	record: &Path,
	host_exit_wait: Duration,
) -> io::Result<Vec<ReapedHost>> {
	// The record may already be claimed by a sweep elsewhere; the sweep of the
	// whole directory below still covers it.
	if let Some(host) = read_header(record) {
		let deadline = Instant::now() + host_exit_wait;
		while host_alive(host) {
			if Instant::now() >= deadline {
				return Ok(Vec::new());
			}
			std::thread::sleep(POLL_INTERVAL);
		}
	}
	sweep(dir)
}

/// Terminate everything the records in `dir` still own for hosts that are no
/// longer alive, removing each record once reaped. Live hosts' records and
/// records another live reaper has claimed are left alone.
pub fn sweep(dir: &Path) -> io::Result<Vec<ReapedHost>> {
	let entries = match fs::read_dir(dir) {
		Ok(entries) => entries,
		Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
		Err(err) => return Err(err),
	};
	let me = std::process::id().cast_signed();
	let mut reaped = Vec::new();
	for dir_entry in entries.flatten() {
		let name = dir_entry.file_name();
		let Some(name) = name.to_str() else {
			continue;
		};
		let Some(base) = claimable_record_base(name) else {
			continue;
		};
		let path = dir_entry.path();
		let Some(host) = read_header(&path) else {
			// Empty or foreign file: a host may be between creating its record
			// and writing the header. Never delete what we cannot attribute.
			continue;
		};
		if host_alive(host) {
			continue;
		}
		// Claim by rename so concurrent reapers (the supervisor and a new
		// host's startup sweep) never both reap and both report one record.
		let claimed = dir.join(format!("{base}{CLAIM_INFIX}{me}"));
		if fs::rename(&path, &claimed).is_err() {
			continue;
		}
		let content = fs::read_to_string(&claimed).unwrap_or_default();
		let recorded: Vec<Entry> = content.lines().skip(1).filter_map(parse_entry).collect();
		let processes = reap_entries(&recorded);
		let _ = fs::remove_file(&claimed);
		if processes > 0 {
			reaped.push(ReapedHost { host_pid: host.pid, processes });
		}
	}
	Ok(reaped)
}

/// Base name (`<pid>-<start>.lifeline`) of a record this process may reap:
/// unclaimed, or claimed by a reaper that is no longer alive.
fn claimable_record_base(name: &str) -> Option<&str> {
	let suffix = format!(".{RECORD_EXTENSION}");
	if name.ends_with(&suffix) {
		return Some(name);
	}
	let (base, claimer) = name.split_once(CLAIM_INFIX)?;
	if !base.ends_with(&suffix) {
		return None;
	}
	let claimer: i32 = claimer.parse().ok()?;
	let claimer_alive = process::process_row(claimer).is_some_and(|row| !row.zombie);
	(!claimer_alive).then_some(base)
}

fn format_entry(row: &ProcessRow) -> String {
	let flags = match (row.pgid == row.pid, row.sid == row.pid) {
		(true, true) => "gs",
		(true, false) => "g",
		(false, true) => "s",
		(false, false) => "-",
	};
	format!("{} {} {flags}\n", row.pid, row.start)
}

/// Host identity from a record's first line, without reading its entries.
fn read_header(path: &Path) -> Option<HostIdentity> {
	let mut line = String::new();
	io::BufReader::new(File::open(path).ok()?)
		.read_line(&mut line)
		.ok()?;
	let mut fields = line.split_whitespace();
	if fields.next()? != HEADER_TAG {
		return None;
	}
	Some(HostIdentity { pid: fields.next()?.parse().ok()?, start: fields.next()?.parse().ok()? })
}

fn parse_entry(line: &str) -> Option<Entry> {
	let mut fields = line.split_whitespace();
	let pid = fields.next()?.parse().ok()?;
	let start = fields.next()?.parse().ok()?;
	let flags = fields.next()?;
	Some(Entry { pid, start, leads_group: flags.contains('g'), leads_session: flags.contains('s') })
}

fn self_identity() -> io::Result<HostIdentity> {
	let pid = std::process::id().cast_signed();
	let row = process::process_row(pid)
		.ok_or_else(|| io::Error::other("cannot read this process's start time"))?;
	Ok(HostIdentity { pid, start: row.start })
}

fn host_alive(host: HostIdentity) -> bool {
	process::process_row(host.pid).is_some_and(|row| row.start == host.start && !row.zombie)
}

/// Signal everything `recorded` still owns in escalating waves, rescanning the
/// process table each wave so children forked mid-reap are caught too.
/// Returns how many distinct live processes were signalled.
fn reap_entries(recorded: &[Entry]) -> u32 {
	let me = std::process::id().cast_signed();
	let began = Instant::now();
	let mut signalled: HashSet<(i32, u64)> = HashSet::new();
	for wave in 0.. {
		let targets = owned_processes(recorded, &process::process_table(), me);
		if targets.is_empty() {
			break;
		}
		let signal = if wave == 0 {
			libc::SIGTERM
		} else {
			libc::SIGKILL
		};
		for target in &targets {
			// There is no atomic "kill iff start matches"; re-validating right
			// before the signal narrows the pid-reuse window to a syscall.
			let same = process::process_row(target.pid)
				.is_some_and(|now| now.start == target.start && !now.zombie);
			// SAFETY: `kill` takes integer arguments and reads no caller memory.
			if same && unsafe { libc::kill(target.pid, signal) } == 0 {
				signalled.insert((target.pid, target.start));
			}
		}
		wait_until_gone(&targets, if wave == 0 { TERM_GRACE } else { KILL_GRACE });
		if began.elapsed() >= REAP_DEADLINE {
			break;
		}
	}
	u32::try_from(signalled.len()).unwrap_or(u32::MAX)
}

fn wait_until_gone(targets: &[ProcessRow], grace: Duration) {
	let deadline = Instant::now() + grace;
	while Instant::now() < deadline {
		let any_alive = targets.iter().any(|target| {
			process::process_row(target.pid)
				.is_some_and(|now| now.start == target.start && !now.zombie)
		});
		if !any_alive {
			return;
		}
		std::thread::sleep(POLL_INTERVAL);
	}
}

/// Live processes `recorded` owns in `table`: every recorded process still
/// alive, every member of a group or session a recorded process led (even if
/// the leader exited), and all descendants of those. The reaper itself, its
/// ancestors, and its own descendants are never included, so a sweep started
/// from inside an orphaned tree cannot take itself or its caller down.
fn owned_processes(recorded: &[Entry], table: &[ProcessRow], me: i32) -> Vec<ProcessRow> {
	let by_pid: HashMap<i32, &ProcessRow> = table.iter().map(|row| (row.pid, row)).collect();
	let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
	for row in table {
		children.entry(row.ppid).or_default().push(row.pid);
	}

	let mut protected: HashSet<i32> = HashSet::new();
	let mut ancestor = Some(me);
	while let Some(pid) = ancestor.filter(|pid| *pid > 1 && protected.insert(*pid)) {
		ancestor = by_pid.get(&pid).map(|row| row.ppid);
	}
	let mut own_subtree = VecDeque::from([me]);
	while let Some(pid) = own_subtree.pop_front() {
		for &child in children.get(&pid).into_iter().flatten() {
			if protected.insert(child) {
				own_subtree.push_back(child);
			}
		}
	}

	let mut seeds: Vec<i32> = Vec::new();
	let mut groups: HashSet<i32> = HashSet::new();
	let mut sessions: HashSet<i32> = HashSet::new();
	for entry in recorded {
		match by_pid.get(&entry.pid) {
			// The pid now names another process: POSIX never reuses a pid
			// while it is still a live group or session id, so ours are gone.
			Some(row) if row.start != entry.start => continue,
			Some(_) => seeds.push(entry.pid),
			None => {},
		}
		if entry.leads_group {
			groups.insert(entry.pid);
		}
		if entry.leads_session {
			sessions.insert(entry.pid);
		}
	}
	seeds.extend(
		table
			.iter()
			.filter(|row| groups.contains(&row.pgid) || sessions.contains(&row.sid))
			.map(|row| row.pid),
	);

	let mut owned: HashSet<i32> = HashSet::new();
	let mut queue: VecDeque<i32> = seeds.into_iter().collect();
	while let Some(pid) = queue.pop_front() {
		if pid <= 1 || protected.contains(&pid) || !owned.insert(pid) {
			continue;
		}
		queue.extend(children.get(&pid).into_iter().flatten().copied());
	}
	table
		.iter()
		.filter(|row| owned.contains(&row.pid) && !row.zombie)
		.copied()
		.collect()
}

/// Spawn the supervisor shell in a new session with the read end of a fresh
/// pipe as stdin, returning the write end the caller must keep open for as
/// long as the supervised host lives. Uses `posix_spawn` (no `fork` in the
/// multi-threaded host).
fn spawn_supervisor(reaper: &[String], reaper_cwd: Option<&Path>) -> io::Result<OwnedFd> {
	let (read_end, write_end) = cloexec_pipe()?;
	let cwd = reaper_cwd.map_or_else(|| OsStr::new(""), Path::as_os_str);
	let mut argv: Vec<CString> = vec![
		c_string(OsStr::new("/bin/sh"))?,
		c_string(OsStr::new("-c"))?,
		c_string(OsStr::new(SUPERVISOR_SCRIPT))?,
		c_string(OsStr::new("omp-lifeline"))?,
		c_string(cwd)?,
	];
	for arg in reaper {
		argv.push(c_string(OsStr::new(arg))?);
	}
	let envp: Vec<CString> = std::env::vars_os()
		.filter_map(|(key, value)| {
			let mut pair = key.as_bytes().to_vec();
			pair.push(b'=');
			pair.extend_from_slice(value.as_bytes());
			CString::new(pair).ok()
		})
		.collect();
	let mut argv_ptrs: Vec<*mut libc::c_char> = argv.iter().map(|s| s.as_ptr().cast_mut()).collect();
	argv_ptrs.push(std::ptr::null_mut());
	let mut envp_ptrs: Vec<*mut libc::c_char> = envp.iter().map(|s| s.as_ptr().cast_mut()).collect();
	envp_ptrs.push(std::ptr::null_mut());

	let flags = SPAWN_SETSID
		| SPAWN_CLOEXEC_DEFAULT
		| libc::POSIX_SPAWN_SETSIGMASK
		| libc::POSIX_SPAWN_SETSIGDEF;
	#[allow(clippy::cast_possible_truncation, reason = "posix_spawn flags fit in c_short")]
	let flags = flags as libc::c_short;

	let mut pid: libc::pid_t = 0;
	// SAFETY: the attribute and file-action objects are initialised before use
	// and destroyed afterwards; every pointer handed to `posix_spawn` (path,
	// NUL-terminated argv/envp arrays of live `CString`s, the signal sets)
	// outlives the call; the descriptors named in file actions are open.
	let rc = unsafe {
		let mut actions: libc::posix_spawn_file_actions_t = std::mem::zeroed();
		let mut attr: libc::posix_spawnattr_t = std::mem::zeroed();
		libc::posix_spawn_file_actions_init(&raw mut actions);
		libc::posix_spawnattr_init(&raw mut attr);
		libc::posix_spawn_file_actions_adddup2(&raw mut actions, read_end.as_raw_fd(), 0);
		libc::posix_spawn_file_actions_addopen(
			&raw mut actions,
			1,
			c"/dev/null".as_ptr(),
			libc::O_WRONLY,
			0,
		);
		libc::posix_spawn_file_actions_adddup2(&raw mut actions, 1, 2);
		let mut empty: libc::sigset_t = std::mem::zeroed();
		libc::sigemptyset(&raw mut empty);
		libc::posix_spawnattr_setsigmask(&raw mut attr, &raw const empty);
		let mut defaults: libc::sigset_t = std::mem::zeroed();
		libc::sigemptyset(&raw mut defaults);
		for signal in [libc::SIGHUP, libc::SIGINT, libc::SIGQUIT, libc::SIGTERM, libc::SIGPIPE] {
			libc::sigaddset(&raw mut defaults, signal);
		}
		libc::posix_spawnattr_setsigdefault(&raw mut attr, &raw const defaults);
		libc::posix_spawnattr_setflags(&raw mut attr, flags);
		let rc = libc::posix_spawn(
			&raw mut pid,
			c"/bin/sh".as_ptr(),
			&raw const actions,
			&raw const attr,
			argv_ptrs.as_ptr(),
			envp_ptrs.as_ptr(),
		);
		libc::posix_spawn_file_actions_destroy(&raw mut actions);
		libc::posix_spawnattr_destroy(&raw mut attr);
		rc
	};
	if rc != 0 {
		return Err(io::Error::from_raw_os_error(rc));
	}
	drop(read_end);
	// The outer shell exits as soon as it has backgrounded the watcher; reap
	// it off-thread so it never lingers as a zombie of the host.
	std::thread::spawn(move || {
		// SAFETY: `pid` is a child this process just spawned; a null status
		// pointer is accepted.
		unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) };
	});
	Ok(write_end)
}

fn c_string(value: &OsStr) -> io::Result<CString> {
	CString::new(value.as_bytes()).map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))
}

/// `(read, write)` pipe with close-on-exec on both ends.
fn cloexec_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
	let mut fds = [0 as libc::c_int; 2];
	// SAFETY: `fds` is a writable two-element array, as `pipe` requires.
	#[cfg(target_os = "linux")]
	let rc = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) };
	// SAFETY: as above; macOS has no `pipe2`, so close-on-exec is set after.
	#[cfg(not(target_os = "linux"))]
	let rc = unsafe { libc::pipe(fds.as_mut_ptr()) };
	if rc != 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `pipe` succeeded, so both descriptors are open and now owned
	// solely by these `OwnedFd`s.
	let (read_end, write_end) =
		unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
	#[cfg(not(target_os = "linux"))]
	for fd in [&read_end, &write_end] {
		// SAFETY: `fd` is an open descriptor owned above.
		if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
			return Err(io::Error::last_os_error());
		}
	}
	Ok((read_end, write_end))
}

#[cfg(test)]
mod tests {
	use std::process::{Command, Stdio};

	use super::*;

	/// Run `script` under `sh` so the processes it prints are orphans (their
	/// launcher exits), like a dead host's commands, and return the printed
	/// pids.
	fn orphaned(script: &str, expected: usize) -> Vec<i32> {
		let output = Command::new("/bin/sh")
			.arg("-c")
			.arg(script)
			.stdin(Stdio::null())
			.stderr(Stdio::inherit())
			.output()
			.expect("run launcher");
		let pids: Vec<i32> = String::from_utf8_lossy(&output.stdout)
			.split_whitespace()
			.map(|pid| pid.parse().expect("pid"))
			.collect();
		assert_eq!(pids.len(), expected, "launcher printed {pids:?}");
		pids
	}

	/// `perl` as a portable `setsid(1)`: macOS ships no `setsid` binary.
	const SETSID: &str = r#"perl -MPOSIX -e "POSIX::setsid(); exec @ARGV or die""#;

	fn row(pid: i32) -> ProcessRow {
		process::process_row(pid).expect("process is alive")
	}

	/// Row of `pid` once it leads its own session: `perl` may not have run
	/// `setsid` yet when the launcher printed its pid.
	fn session_leader(pid: i32) -> ProcessRow {
		let deadline = Instant::now() + Duration::from_secs(5);
		loop {
			let current = row(pid);
			if current.sid == pid || Instant::now() >= deadline {
				return current;
			}
			std::thread::sleep(POLL_INTERVAL);
		}
	}

	fn alive(target: ProcessRow) -> bool {
		process::process_row(target.pid).is_some_and(|now| now.start == target.start && !now.zombie)
	}

	fn kill(rows: &[ProcessRow]) {
		for target in rows {
			if alive(*target) {
				// SAFETY: plain signal to a validated test child.
				unsafe { libc::kill(target.pid, libc::SIGKILL) };
			}
		}
	}

	/// A record whose host is some already-exited process.
	fn dead_host_record(dir: &Path, commands: &[ProcessRow]) -> PathBuf {
		let mut exited = Command::new("/bin/sh")
			.arg("-c")
			.arg("exit 0")
			.spawn()
			.expect("spawn");
		let host = HostIdentity { pid: exited.id().cast_signed(), start: 1 };
		exited.wait().expect("wait");
		write_record(dir, host, commands)
	}

	fn write_record(dir: &Path, host: HostIdentity, commands: &[ProcessRow]) -> PathBuf {
		let mut content = format!("{HEADER_TAG} {} {}\n", host.pid, host.start);
		for command in commands {
			content.push_str(&format_entry(command));
		}
		let path = dir.join(format!("{}-{}.{RECORD_EXTENSION}", host.pid, host.start));
		fs::write(&path, content).expect("write record");
		path
	}

	#[test]
	fn sweep_kills_the_whole_tree_of_a_dead_host_command() {
		let dir = tempfile::tempdir().expect("tempdir");
		// The recorded command leads its own session (as brush arranges) and
		// starts a plain child plus a grandchild that escapes into a new session.
		let pids = orphaned(
			&format!(
				"{SETSID} sh -c 'echo $$; sleep 600 >/dev/null & echo $!; {SETSID} sleep 600 \
				 >/dev/null & echo $!; exec sleep 600 >/dev/null' &"
			),
			3,
		);
		let (command, child, escaped) = (row(pids[0]), row(pids[1]), session_leader(pids[2]));
		assert_eq!(command.sid, command.pid, "recorded command must lead its session");
		assert_ne!(escaped.sid, command.sid, "grandchild must be in its own session");
		let record = dead_host_record(dir.path(), &[command]);

		let reaped = sweep(dir.path()).expect("sweep");

		let tree = [command, child, escaped];
		let survivors: Vec<_> = tree.iter().filter(|target| alive(**target)).collect();
		kill(&tree);
		assert!(survivors.is_empty(), "survivors: {survivors:?}");
		assert_eq!(reaped, vec![ReapedHost { host_pid: reaped[0].host_pid, processes: 3 }]);
		assert!(!record.exists(), "a reaped record is removed");
	}

	#[test]
	fn sweep_kills_session_members_whose_recorded_leader_already_exited() {
		let dir = tempfile::tempdir().expect("tempdir");
		// The leader backgrounds a loop and exits: the loop is reparented to
		// init but stays in the recorded session.
		let pids = orphaned(
			&format!(
				"{SETSID} sh -c 'echo $$; sleep 600 >/dev/null & echo $!; exec >/dev/null; sleep 1' &"
			),
			2,
		);
		let (leader, member) = (row(pids[0]), row(pids[1]));
		let deadline = Instant::now() + Duration::from_secs(5);
		while alive(leader) && Instant::now() < deadline {
			std::thread::sleep(POLL_INTERVAL);
		}
		assert!(!alive(leader), "leader exited");
		assert_eq!(member.sid, leader.pid);
		dead_host_record(dir.path(), &[leader]);

		let reaped = sweep(dir.path()).expect("sweep");

		let survived = alive(member);
		kill(&[member]);
		assert!(!survived, "orphaned session member survived");
		assert_eq!(reaped[0].processes, 1);
	}

	#[test]
	fn sweep_leaves_live_hosts_and_daemonized_escapes_alone() {
		let dir = tempfile::tempdir().expect("tempdir");
		let live_host = self_identity().expect("self identity");
		let owned_by_live = orphaned(&format!("{SETSID} sleep 600 >/dev/null & echo $!"), 1);
		let live_command = row(owned_by_live[0]);
		let live_record = write_record(dir.path(), live_host, &[live_command]);

		// A dead host's command double-forks a daemon into its own session
		// (the `rig-detached-*` launcher shape) before the host dies.
		let pids = orphaned(
			&format!(
				"{SETSID} sh -c 'echo $$; ( {SETSID} sleep 600 >/dev/null & echo $! ); exec sleep 600 \
				 >/dev/null' &"
			),
			2,
		);
		let (command, daemon) = (row(pids[0]), session_leader(pids[1]));
		assert_ne!(row(daemon.pid).ppid, command.pid, "daemon reparented away from its launcher");
		dead_host_record(dir.path(), &[command]);

		let reaped = sweep(dir.path()).expect("sweep");

		let (live_survived, daemon_survived, command_survived) =
			(alive(live_command), alive(daemon), alive(command));
		kill(&[live_command, daemon, command]);
		assert!(live_survived, "a live host's command was killed");
		assert!(live_record.exists(), "a live host's record was consumed");
		assert!(daemon_survived, "a daemonized escape was killed");
		assert!(!command_survived, "the dead host's command survived");
		assert_eq!(reaped[0].processes, 1);
	}

	#[test]
	fn supervisor_runs_the_reaper_only_after_the_host_end_closes() {
		let dir = tempfile::tempdir().expect("tempdir");
		let marker = dir.path().join("reaped");
		let reaper = vec![
			"/bin/sh".to_owned(),
			"-c".to_owned(),
			r#"echo "$PWD" > "$0""#.to_owned(),
			marker.to_string_lossy().into_owned(),
		];
		let lifeline = spawn_supervisor(&reaper, Some(dir.path())).expect("spawn supervisor");

		std::thread::sleep(Duration::from_millis(300));
		assert!(!marker.exists(), "reaper ran while the host end was still open");
		drop(lifeline);
		let deadline = Instant::now() + Duration::from_secs(5);
		while !marker.exists() && Instant::now() < deadline {
			std::thread::sleep(POLL_INTERVAL);
		}
		let cwd = fs::read_to_string(&marker).expect("reaper ran after the host end closed");
		assert_eq!(
			fs::canonicalize(cwd.trim()).expect("canonical cwd"),
			fs::canonicalize(dir.path()).expect("canonical dir")
		);
	}
}
