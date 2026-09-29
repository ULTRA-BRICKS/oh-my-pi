//! Fork-free process launch for macOS, built on `posix_spawn(2)`.
//!
//! `std::process::Command` falls back to `fork()` + `exec()` whenever a
//! `pre_exec` closure is registered (brush uses them for `setsid` and for
//! descriptors beyond stdio) or a relative program is combined with a working
//! directory. In a multi-threaded host that is fatal on macOS: every `fork()`
//! runs libSystem's atfork handlers, and libmalloc's handlers read the lazily
//! registered MallocStackLogging hooks once in prepare and again in parent. A
//! memory-pressure event that registers those hooks in between makes
//! `_malloc_fork_parent` unlock a lock that prepare never took; libplatform
//! traps ("Unlock of an os_unfair_lock not owned by current thread") and the
//! kernel SIGKILLs the whole host (oh-my-pi#11). `posix_spawn` creates the
//! child in one kernel call and never runs atfork handlers.

use std::ffi::{CString, OsStr, OsString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{ExitStatus, Output};

/// `POSIX_SPAWN_SETSID` from `<spawn.h>` (macOS 10.15+); not exported by `libc`.
const POSIX_SPAWN_SETSID: libc::c_short = 0x0400;

unsafe extern "C" {
	/// `posix_spawn_file_actions_addchdir_np` from `<spawn.h>` (macOS 10.15+);
	/// not exported by `libc` for Apple targets.
	fn posix_spawn_file_actions_addchdir_np(
		actions: *mut libc::posix_spawn_file_actions_t,
		path: *const libc::c_char,
	) -> libc::c_int;
}

/// How the child is placed into a session and process group.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionSetup {
	/// Stay in the caller's session and process group.
	Inherit,
	/// Join the process group with this id; `0` makes the child lead a new one.
	ProcessGroup(libc::pid_t),
	/// Start a new session (and process group) with no controlling terminal.
	/// A terminal the child opens through [`SpawnRequest::open`] becomes its
	/// controlling terminal.
	NewSession,
}

/// Where a child descriptor comes from.
#[derive(Debug)]
enum FdSource {
	/// Duplicate a descriptor the caller owns.
	Owned(OwnedFd),
	/// Open a path in the child, after `setsid`.
	Open { path: PathBuf, flags: libc::c_int },
}

/// A [`FdSource`] ready for the file actions.
enum FdAction {
	Dup(OwnedFd),
	Open { path: CString, flags: libc::c_int },
}

/// Everything needed to launch one child with [`spawn`].
#[derive(Debug)]
pub struct SpawnRequest {
	program:          PathBuf,
	argv:             Vec<OsString>,
	env:              Vec<(OsString, OsString)>,
	cwd:              Option<PathBuf>,
	fds:              Vec<(RawFd, FdSource)>,
	session:          SessionSetup,
	default_signals:  Vec<libc::c_int>,
	close_unmapped:   bool,
}

impl SpawnRequest {
	/// Starts a request for `program`, whose `argv[0]` is `argv0`.
	///
	/// A relative `program` is resolved against the working directory, as an
	/// `exec` after `chdir` would. The child environment starts empty.
	pub fn new(program: impl Into<PathBuf>, argv0: impl Into<OsString>) -> Self {
		Self {
			program:         program.into(),
			argv:            vec![argv0.into()],
			env:             Vec::new(),
			cwd:             None,
			fds:             Vec::new(),
			session:         SessionSetup::Inherit,
			default_signals: Vec::new(),
			close_unmapped:  false,
		}
	}

	/// Appends an argument.
	pub fn arg(&mut self, arg: impl Into<OsString>) -> &mut Self {
		self.argv.push(arg.into());
		self
	}

	/// Adds `key=value` to the child's environment. Keys must be unique.
	pub fn env(&mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> &mut Self {
		self.env.push((key.into(), value.into()));
		self
	}

	/// Sets the child's working directory.
	pub fn cwd(&mut self, dir: impl Into<PathBuf>) -> &mut Self {
		self.cwd = Some(dir.into());
		self
	}

	/// Makes `fd` the child's descriptor `child_fd`. Descriptors that are not
	/// mapped are inherited unless they are close-on-exec.
	pub fn fd(&mut self, child_fd: RawFd, fd: OwnedFd) -> &mut Self {
		self.fds.push((child_fd, FdSource::Owned(fd)));
		self
	}

	/// Opens `path` with `flags` in the child as descriptor `child_fd`. With
	/// [`SessionSetup::NewSession`], a terminal opened this way becomes the
	/// child's controlling terminal.
	pub fn open(&mut self, child_fd: RawFd, path: impl Into<PathBuf>, flags: libc::c_int) -> &mut Self {
		self.fds.push((child_fd, FdSource::Open { path: path.into(), flags }));
		self
	}

	/// Sets how the child joins a session and process group.
	pub const fn session(&mut self, session: SessionSetup) -> &mut Self {
		self.session = session;
		self
	}

	/// Resets `signal` to its default disposition in the child (`SIGPIPE`
	/// always is).
	pub fn default_signal(&mut self, signal: libc::c_int) -> &mut Self {
		self.default_signals.push(signal);
		self
	}

	/// Closes every descriptor in the child that is not mapped with
	/// [`Self::fd`] or [`Self::open`], close-on-exec or not.
	pub const fn close_unmapped_fds(&mut self) -> &mut Self {
		self.close_unmapped = true;
		self
	}
}

/// Launches `request` with `posix_spawnp`.
///
/// Like `std::process::Command`, the child starts with an empty signal mask
/// and `SIGPIPE` at its default disposition.
pub fn spawn(request: SpawnRequest) -> io::Result<Child> {
	let SpawnRequest { program, argv, env, cwd, fds, session, default_signals, close_unmapped } =
		request;

	let program = match &cwd {
		Some(cwd) if program.is_relative() => cwd.join(program),
		_ => program,
	};
	let program = c_string(program.as_os_str())?;
	let cwd = cwd.map(|cwd| c_string(cwd.as_os_str())).transpose()?;
	let argv = argv.iter().map(|arg| c_string(arg)).collect::<io::Result<Vec<_>>>()?;
	let env = env
		.iter()
		.map(|(key, value)| {
			let mut entry = Vec::with_capacity(key.len() + 1 + value.len());
			entry.extend_from_slice(key.as_bytes());
			entry.push(b'=');
			entry.extend_from_slice(value.as_bytes());
			Ok(CString::new(entry)?)
		})
		.collect::<io::Result<Vec<_>>>()?;

	// File actions run in order, so a source descriptor that is also an earlier
	// target would be overwritten before its own `dup2`. Moving every source
	// above every target rules that out. The duplicates stay close-on-exec;
	// `dup2` clears the flag on the target only.
	let floor = fds
		.iter()
		.map(|(child_fd, _)| child_fd + 1)
		.max()
		.unwrap_or(0)
		.max(libc::STDERR_FILENO + 1);
	let fds = fds
		.into_iter()
		.map(|(child_fd, source)| {
			let action = match source {
				FdSource::Owned(fd) if fd.as_raw_fd() < floor => FdAction::Dup(dup_at_or_above(&fd, floor)?),
				FdSource::Owned(fd) => FdAction::Dup(fd),
				FdSource::Open { path, flags } => FdAction::Open { path: c_string(path.as_os_str())?, flags },
			};
			Ok((child_fd, action))
		})
		.collect::<io::Result<Vec<_>>>()?;

	let mut actions = FileActions::new()?;
	if let Some(cwd) = &cwd {
		// SAFETY: `actions` is initialized and `cwd` outlives the spawn call.
		check(unsafe { posix_spawn_file_actions_addchdir_np(actions.as_mut_ptr(), cwd.as_ptr()) })?;
	}
	for (child_fd, action) in &fds {
		match action {
			// SAFETY: `actions` is initialized; both descriptors are plain ints.
			FdAction::Dup(fd) => check(unsafe {
				libc::posix_spawn_file_actions_adddup2(actions.as_mut_ptr(), fd.as_raw_fd(), *child_fd)
			})?,
			// SAFETY: `actions` is initialized and `path` outlives the spawn call.
			FdAction::Open { path, flags } => check(unsafe {
				libc::posix_spawn_file_actions_addopen(
					actions.as_mut_ptr(),
					*child_fd,
					path.as_ptr(),
					*flags,
					0,
				)
			})?,
		}
	}

	let mut attrs = SpawnAttrs::new()?;
	// SAFETY: an all-zero `sigset_t` is the empty set on Apple platforms.
	let empty_set: libc::sigset_t = unsafe { std::mem::zeroed() };
	let mut default_set = empty_set;
	for signal in std::iter::once(libc::SIGPIPE).chain(default_signals) {
		// SAFETY: `default_set` is a valid `sigset_t`; an invalid signal
		// number is reported through the checked return value.
		check_errno(unsafe { libc::sigaddset(&raw mut default_set, signal) })?;
	}
	// SAFETY: `attrs` is initialized and both sets are valid for the call.
	check(unsafe { libc::posix_spawnattr_setsigmask(attrs.as_mut_ptr(), &raw const empty_set) })?;
	// SAFETY: as above.
	check(unsafe { libc::posix_spawnattr_setsigdefault(attrs.as_mut_ptr(), &raw const default_set) })?;
	let mut flags = libc::POSIX_SPAWN_SETSIGMASK | libc::POSIX_SPAWN_SETSIGDEF;
	if close_unmapped {
		flags |= libc::POSIX_SPAWN_CLOEXEC_DEFAULT;
	}
	match session {
		SessionSetup::Inherit => {},
		SessionSetup::ProcessGroup(pgid) => {
			flags |= libc::POSIX_SPAWN_SETPGROUP;
			// SAFETY: `attrs` is initialized.
			check(unsafe { libc::posix_spawnattr_setpgroup(attrs.as_mut_ptr(), pgid) })?;
		},
		SessionSetup::NewSession => flags |= libc::c_int::from(POSIX_SPAWN_SETSID),
	}
	let flags = libc::c_short::try_from(flags).map_err(io::Error::other)?;
	// SAFETY: `attrs` is initialized.
	check(unsafe { libc::posix_spawnattr_setflags(attrs.as_mut_ptr(), flags) })?;

	let argv = null_terminated(&argv);
	let env = null_terminated(&env);
	let mut pid: libc::pid_t = 0;
	// SAFETY: every pointer stays valid for the call: `program`, the
	// NUL-terminated `argv`/`env` arrays and the strings they point into, and
	// the initialized `actions`/`attrs`; `posix_spawnp` only reads them. An
	// absolute `program` skips the PATH search, and `posix_spawnp` (unlike
	// `posix_spawn`) still runs a script without `#!` through `/bin/sh`, as
	// `execvp` does.
	check(unsafe {
		libc::posix_spawnp(
			&raw mut pid,
			program.as_ptr(),
			actions.as_mut_ptr(),
			attrs.as_mut_ptr(),
			argv.as_ptr(),
			env.as_ptr(),
		)
	})?;
	Ok(Child { pid, status: None })
}

/// A child launched by [`spawn`].
///
/// Dropping it before it has been reaped kills it with `SIGKILL` and reaps it
/// in the background, like `tokio::process::Child` with `kill_on_drop`.
#[derive(Debug)]
pub struct Child {
	pid:    libc::pid_t,
	status: Option<ExitStatus>,
}

impl Child {
	/// Returns the child's process id.
	pub const fn id(&self) -> u32 {
		self.pid.unsigned_abs()
	}

	/// Reaps the child if it has exited.
	pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
		if self.status.is_none() {
			self.status = try_reap(self.pid)?;
		}
		Ok(self.status)
	}

	/// Waits for the child to exit and reaps it.
	pub async fn wait(&mut self) -> io::Result<ExitStatus> {
		// Subscribe before the first check, or an exit between the check and
		// the subscription would never wake us.
		let mut sigchld = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child())?;
		loop {
			if let Some(status) = self.try_wait()? {
				return Ok(status);
			}
			if sigchld.recv().await.is_none() {
				return Err(io::Error::other("SIGCHLD stream closed while waiting for a child"));
			}
		}
	}

	/// Blocks the calling thread until the child exits, and reaps it.
	pub fn wait_blocking(&mut self) -> io::Result<ExitStatus> {
		if let Some(status) = self.status {
			return Ok(status);
		}
		loop {
			let mut status = 0;
			// SAFETY: a blocking `waitpid` on our own child with a valid out-pointer.
			if unsafe { libc::waitpid(self.pid, &raw mut status, 0) } != -1 {
				let status = ExitStatus::from_raw(status);
				self.status = Some(status);
				return Ok(status);
			}
			let err = io::Error::last_os_error();
			if err.kind() != io::ErrorKind::Interrupted {
				return Err(err);
			}
		}
	}

	/// Waits for the child to exit. Its stdio is never piped, so the captured
	/// output is always empty.
	pub async fn wait_with_output(mut self) -> io::Result<Output> {
		let status = self.wait().await?;
		Ok(Output { status, stdout: Vec::new(), stderr: Vec::new() })
	}
}

impl Drop for Child {
	fn drop(&mut self) {
		if self.status.is_some() {
			return;
		}
		// SAFETY: `kill` takes the pid by value; the child is unreaped, so the
		// pid still names it.
		unsafe { libc::kill(self.pid, libc::SIGKILL) };
		if matches!(try_reap(self.pid), Ok(None)) {
			reap_in_background(self.pid);
		}
	}
}

/// Reaps a killed child that has not exited yet without blocking the caller.
fn reap_in_background(pid: libc::pid_t) {
	let Ok(runtime) = tokio::runtime::Handle::try_current() else {
		std::thread::spawn(move || reap_blocking(pid));
		return;
	};
	runtime.spawn(async move {
		if let Ok(mut sigchld) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child()) {
			while matches!(try_reap(pid), Ok(None)) {
				if sigchld.recv().await.is_none() {
					std::thread::spawn(move || reap_blocking(pid));
					return;
				}
			}
			return;
		}
		std::thread::spawn(move || reap_blocking(pid));
	});
}

fn reap_blocking(pid: libc::pid_t) {
	let mut status = 0;
	// SAFETY: a blocking `waitpid` on our own child with a valid out-pointer.
	while unsafe { libc::waitpid(pid, &raw mut status, 0) } == -1
		&& io::Error::last_os_error().kind() == io::ErrorKind::Interrupted
	{}
}

/// `waitpid(pid, WNOHANG)`: the exit status once the child has exited.
fn try_reap(pid: libc::pid_t) -> io::Result<Option<ExitStatus>> {
	loop {
		let mut status = 0;
		// SAFETY: `waitpid` on our own child with a valid out-pointer.
		match unsafe { libc::waitpid(pid, &raw mut status, libc::WNOHANG) } {
			0 => return Ok(None),
			-1 => {
				let err = io::Error::last_os_error();
				if err.kind() != io::ErrorKind::Interrupted {
					return Err(err);
				}
			},
			_ => return Ok(Some(ExitStatus::from_raw(status))),
		}
	}
}

fn c_string(value: &OsStr) -> io::Result<CString> {
	Ok(CString::new(value.as_bytes())?)
}

fn null_terminated(strings: &[CString]) -> Vec<*mut libc::c_char> {
	strings
		.iter()
		.map(|string| string.as_ptr().cast_mut())
		.chain(std::iter::once(std::ptr::null_mut()))
		.collect()
}

/// Duplicates `fd` to the lowest free descriptor `>= floor`, close-on-exec.
fn dup_at_or_above(fd: &OwnedFd, floor: RawFd) -> io::Result<OwnedFd> {
	// SAFETY: `F_DUPFD_CLOEXEC` on a valid descriptor; the result is checked.
	let duplicate = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, floor) };
	check_errno(duplicate)?;
	// SAFETY: `fcntl` returned a fresh descriptor that nothing else owns.
	Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}

/// Maps a `posix_spawn*` return code (an errno value, 0 on success).
fn check(code: libc::c_int) -> io::Result<()> {
	if code == 0 { Ok(()) } else { Err(io::Error::from_raw_os_error(code)) }
}

/// Maps a libc return value that signals failure with `-1` and `errno`.
fn check_errno(ret: libc::c_int) -> io::Result<()> {
	if ret == -1 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

/// Owns an initialized `posix_spawn_file_actions_t`.
struct FileActions(libc::posix_spawn_file_actions_t);

impl FileActions {
	fn new() -> io::Result<Self> {
		let mut actions: libc::posix_spawn_file_actions_t = std::ptr::null_mut();
		// SAFETY: initializes the out-parameter; destroyed in `Drop`.
		check(unsafe { libc::posix_spawn_file_actions_init(&raw mut actions) })?;
		Ok(Self(actions))
	}

	const fn as_mut_ptr(&mut self) -> *mut libc::posix_spawn_file_actions_t {
		&raw mut self.0
	}
}

impl Drop for FileActions {
	fn drop(&mut self) {
		// SAFETY: initialized in `new` and destroyed exactly once.
		unsafe { libc::posix_spawn_file_actions_destroy(&raw mut self.0) };
	}
}

/// Owns an initialized `posix_spawnattr_t`.
struct SpawnAttrs(libc::posix_spawnattr_t);

impl SpawnAttrs {
	fn new() -> io::Result<Self> {
		let mut attrs: libc::posix_spawnattr_t = std::ptr::null_mut();
		// SAFETY: initializes the out-parameter; destroyed in `Drop`.
		check(unsafe { libc::posix_spawnattr_init(&raw mut attrs) })?;
		Ok(Self(attrs))
	}

	const fn as_mut_ptr(&mut self) -> *mut libc::posix_spawnattr_t {
		&raw mut self.0
	}
}

impl Drop for SpawnAttrs {
	fn drop(&mut self) {
		// SAFETY: initialized in `new` and destroyed exactly once.
		unsafe { libc::posix_spawnattr_destroy(&raw mut self.0) };
	}
}
