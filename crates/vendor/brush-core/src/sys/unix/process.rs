//! Process management utilities for macOS.
//!
//! External commands start through [`super::spawn`] so the multi-threaded host
//! never forks. The few launches that need a `pre_exec` hook (taking the
//! terminal foreground, `nohup cmd &`'s double fork) still go through
//! `tokio::process`.

pub(crate) use crate::sys::tokio_process::ProcessId;

/// A running external command.
pub enum Child {
	/// Launched through `tokio::process`.
	Tokio(tokio::process::Child),
	/// Launched with `posix_spawn`.
	Spawned(super::spawn::Child),
}

impl Child {
	/// Returns the child's process id, if it is still known.
	pub(crate) fn id(&self) -> Option<u32> {
		match self {
			Self::Tokio(child) => child.id(),
			Self::Spawned(child) => Some(child.id()),
		}
	}

	/// Waits for the child to exit, collecting any piped output.
	pub(crate) async fn wait_with_output(self) -> std::io::Result<std::process::Output> {
		match self {
			Self::Tokio(child) => child.wait_with_output().await,
			Self::Spawned(child) => child.wait_with_output().await,
		}
	}
}

/// Spawns `command` through `tokio::process`.
pub(crate) fn spawn(command: std::process::Command) -> std::io::Result<Child> {
	crate::sys::tokio_process::spawn(command).map(Child::Tokio)
}
