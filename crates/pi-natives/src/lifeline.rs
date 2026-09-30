//! N-API bindings for the host-death lifeline.
//!
//! The implementation lives in `pi_shell::lifeline`: a per-host record of every
//! command the shell (and the PTY runner) spawns, a supervisor process outside
//! the host that reaps those commands once the host dies for any reason, and a
//! sweep that reaps what crashed hosts left behind. Other platforms get inert
//! functions so callers need no platform checks.

use napi::Result;
use napi_derive::napi;

use crate::task;

/// Processes a sweep terminated on behalf of one dead omp host.
#[napi(object)]
pub struct LifelineReapedHost {
	/// Pid the dead host had.
	pub host_pid:  i32,
	/// Distinct live processes that were signalled.
	pub processes: u32,
}

/// Record this process's shell and PTY spawns and start its host-death
/// supervisor.
///
/// Records go under `dir`. Once this process has died — including `SIGKILL`
/// and native aborts, which run no cleanup code — the supervisor runs `reaper`
/// (an argv, from `reaperCwd` when given, with `dir` and the record path
/// appended). Idempotent. Returns the record path, or `null` where the
/// platform has no lifeline support.
///
/// # Errors
/// Returns an error when the record cannot be created or the supervisor
/// cannot be spawned.
#[napi(js_name = "lifelineStart")]
pub fn lifeline_start(
	dir: String,
	reaper: Vec<String>,
	reaper_cwd: Option<String>,
) -> Result<Option<String>> {
	start(dir, reaper, reaper_cwd)
}

/// Supervisor entry: wait for the host owning `record` to exit, then sweep
/// `dir`.
///
/// Waits up to `hostExitWaitMs`, then terminates what dead hosts' records in
/// `dir` still own. Resolves to one entry per host with at least one process
/// terminated.
#[napi(js_name = "lifelineReapAfterHostExit")]
pub fn lifeline_reap_after_host_exit(
	dir: String,
	record: String,
	host_exit_wait_ms: u32,
) -> task::Promise<Vec<LifelineReapedHost>> {
	task::blocking("lifeline.reap", (), move |_| {
		reap_after_host_exit(dir, record, host_exit_wait_ms)
	})
}

/// Terminate what records in `dir` still own for omp hosts that are no longer
/// alive (a crash that also took the supervisor down). Resolves to one entry
/// per host with at least one process terminated.
#[napi(js_name = "lifelineSweep")]
pub fn lifeline_sweep(dir: String) -> task::Promise<Vec<LifelineReapedHost>> {
	task::blocking("lifeline.sweep", (), move |_| sweep(dir))
}

/// Record a PTY child for the lifeline (no-op until [`lifeline_start`]).
pub(crate) fn record_spawn(pid: i32) {
	#[cfg(unix)]
	pi_shell::lifeline::record_spawn(pid);
	#[cfg(not(unix))]
	let _ = pid;
}

#[cfg(unix)]
fn start(dir: String, reaper: Vec<String>, reaper_cwd: Option<String>) -> Result<Option<String>> {
	let cwd = reaper_cwd.as_deref().map(std::path::Path::new);
	pi_shell::lifeline::start(dir.as_ref(), &reaper, cwd)
		.map(|path| Some(path.to_string_lossy().into_owned()))
		.map_err(|err| napi::Error::from_reason(format!("Failed to start process lifeline: {err}")))
}

#[cfg(unix)]
fn reap_after_host_exit(
	dir: String,
	record: String,
	wait_ms: u32,
) -> Result<Vec<LifelineReapedHost>> {
	let wait = std::time::Duration::from_millis(u64::from(wait_ms));
	pi_shell::lifeline::reap_after_host_exit(dir.as_ref(), record.as_ref(), wait)
		.map(into_js)
		.map_err(|err| napi::Error::from_reason(format!("Process lifeline reap failed: {err}")))
}

#[cfg(unix)]
fn sweep(dir: String) -> Result<Vec<LifelineReapedHost>> {
	pi_shell::lifeline::sweep(dir.as_ref())
		.map(into_js)
		.map_err(|err| napi::Error::from_reason(format!("Process lifeline sweep failed: {err}")))
}

#[cfg(unix)]
fn into_js(reaped: Vec<pi_shell::lifeline::ReapedHost>) -> Vec<LifelineReapedHost> {
	reaped
		.into_iter()
		.map(|host| LifelineReapedHost { host_pid: host.host_pid, processes: host.processes })
		.collect()
}

#[cfg(not(unix))]
#[allow(clippy::unnecessary_wraps, reason = "matches the unix signature")]
fn start(
	_dir: String,
	_reaper: Vec<String>,
	_reaper_cwd: Option<String>,
) -> Result<Option<String>> {
	Ok(None)
}

#[cfg(not(unix))]
#[allow(clippy::unnecessary_wraps, reason = "matches the unix signature")]
fn reap_after_host_exit(
	_dir: String,
	_record: String,
	_wait_ms: u32,
) -> Result<Vec<LifelineReapedHost>> {
	Ok(Vec::new())
}

#[cfg(not(unix))]
#[allow(clippy::unnecessary_wraps, reason = "matches the unix signature")]
fn sweep(_dir: String) -> Result<Vec<LifelineReapedHost>> {
	Ok(Vec::new())
}
